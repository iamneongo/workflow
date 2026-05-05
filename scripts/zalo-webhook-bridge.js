const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();
const { Zalo } = require('zca-js');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.ZALO_BRIDGE_DB_PATH || path.join(ROOT, '.n8n', '.n8n', 'database.sqlite');
const CONFIG_PATH = process.env.ZALO_BRIDGE_CONFIG_PATH || path.join(ROOT, '.n8n', '.n8n', 'config');
const CREDENTIAL_ID = process.env.ZALO_BRIDGE_CREDENTIAL_ID || 'ZiSsMyUEkndy1TDP';
const QUEUE_TABLE =
	process.env.ZALO_BRIDGE_QUEUE_TABLE || 'data_table_user_dad3ca9f-2474-4abc-bbf8-51e85f81eafa';

let activeApi;

function log(message, extra) {
	const stamp = new Date().toISOString();
	if (extra === undefined) {
		console.log(`[zalo-bridge] ${stamp} ${message}`);
		return;
	}
	console.log(`[zalo-bridge] ${stamp} ${message}`, extra);
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function decryptN8nCredential(encrypted, encryptionKey) {
	const input = Buffer.from(encrypted, 'base64');
	const salt = input.subarray(8, 16);
	const password = Buffer.concat([Buffer.from(encryptionKey, 'binary'), salt]);
	const hash1 = crypto.createHash('md5').update(password).digest();
	const hash2 = crypto.createHash('md5').update(Buffer.concat([hash1, password])).digest();
	const iv = crypto.createHash('md5').update(Buffer.concat([hash2, password])).digest();
	const key = Buffer.concat([hash1, hash2]);
	const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
	return Buffer.concat([decipher.update(input.subarray(16)), decipher.final()]).toString('utf8');
}

function loadZaloCredential() {
	const { encryptionKey } = readJson(CONFIG_PATH);
	if (!encryptionKey) {
		throw new Error(`Missing encryptionKey in ${CONFIG_PATH}`);
	}

	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
			if (err) reject(err);
		});

		db.get(
			'select id, name, data from credentials_entity where id = ?',
			[CREDENTIAL_ID],
			(err, row) => {
				if (err) {
					db.close();
					reject(err);
					return;
				}

				if (!row) {
					db.close();
					reject(new Error(`Credential ${CREDENTIAL_ID} not found in ${DB_PATH}`));
					return;
				}

				try {
					const decrypted = decryptN8nCredential(row.data, encryptionKey);
					const parsed = JSON.parse(decrypted);
					resolve({
						id: row.id,
						name: row.name,
						cookie: JSON.parse(parsed.cookie),
						imei: parsed.imei,
						userAgent: parsed.userAgent,
					});
				} catch (parseError) {
					reject(parseError);
				} finally {
					db.close();
				}
			},
		);
	});
}

function insertQueueRow(message) {
	const text = message?.data?.content;
	if (message?.isSelf) {
		return Promise.resolve({ skipped: true, reason: 'self_message' });
	}

	if (typeof text !== 'string' || !text.trim()) {
		return Promise.resolve({ skipped: true, reason: 'empty_text' });
	}

	const threadId = String(message?.threadId ?? '');
	const messageId = String(message?.data?.msgId ?? '');
	const messageTs = String(message?.data?.ts ?? '');
	const queueKey = [threadId, messageId || messageTs].filter(Boolean).join(':') || `${threadId}:${Date.now()}`;
	const senderName = String(message?.data?.displayName ?? message?.data?.dName ?? '');
	const sql = `
		insert into "${QUEUE_TABLE}" (
			queue_key, thread_id, group_name, sender_id, sender_name,
			message_text, message_ts, raw_message_json, status, retry_count,
			last_error, processed_at, summary, attendance_json,
			needs_human_review, confidence, appscript_response
		)
		select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		where not exists (
			select 1 from "${QUEUE_TABLE}" where queue_key = ?
		)
	`;
	const values = [
		queueKey,
		threadId,
		String(message?.data?.dName ?? ''),
		String(message?.data?.uidFrom ?? ''),
		senderName,
		text.trim(),
		messageTs,
		JSON.stringify(message),
		'pending',
		0,
		'',
		null,
		'',
		'',
		0,
		0,
		'',
		queueKey,
	];

	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(DB_PATH);
		db.run(sql, values, function onRun(err) {
			db.close();
			if (err) {
				reject(err);
				return;
			}

			resolve({
				inserted: this.changes > 0,
				queueKey,
				threadId,
				messageId,
			});
		});
	});
}

async function main() {
	const credential = await loadZaloCredential();
	log(`Loaded credential "${credential.name}" (${credential.id})`);
	log(`Writing Zalo messages into queue table ${QUEUE_TABLE}`);

	const zalo = new Zalo({ selfListen: false });
	activeApi = await zalo.login({
		cookie: credential.cookie,
		imei: credential.imei,
		userAgent: credential.userAgent,
	});

	if (!activeApi) {
		throw new Error('Zalo login did not return an API instance');
	}

	activeApi.listener.on('message', async (message) => {
		try {
			const result = await insertQueueRow(message);
			if (result.skipped) {
				log(`Skipped message (${result.reason})`);
				return;
			}

			if (!result.inserted) {
				log(`Skipped duplicate message ${result.messageId || '(no-msg-id)'}`);
				return;
			}

			log(`Queued message ${result.messageId || '(no-msg-id)'} from thread ${result.threadId || '(no-thread)'}`);
		} catch (error) {
			log(`Failed to queue message: ${error.message}`);
		}
	});

	activeApi.listener.start();
	log('Zalo listener started');
}

async function shutdown(signal) {
	log(`Received ${signal}, stopping bridge`);
	try {
		if (activeApi?.listener) {
			activeApi.listener.stop();
		}
	} catch (error) {
		log(`Listener stop warning: ${error.message}`);
	} finally {
		process.exit(0);
	}
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
	log(`Uncaught exception: ${error.stack || error.message}`);
	process.exit(1);
});
process.on('unhandledRejection', (reason) => {
	log(`Unhandled rejection: ${reason?.stack || reason}`);
	process.exit(1);
});

void main().catch((error) => {
	log(`Bridge startup failed: ${error.stack || error.message}`);
	process.exit(1);
});
