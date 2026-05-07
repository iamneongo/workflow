const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();
const { Zalo } = require('zca-js');

const ROOT = path.resolve(__dirname, '..');
const ENV_LOCAL_PATH = path.join(ROOT, '.env.local');
const QR_PATH = path.join(ROOT, 'zalo-login-qr.png');
const CONFIG_PATH = path.join(ROOT, '.n8n', '.n8n', 'config');
const DB_PATH = path.join(ROOT, '.n8n', '.n8n', 'database.sqlite');
const TARGET_CREDENTIAL_ID = String(process.env.ZALO_BRIDGE_CREDENTIAL_ID || 'ZiSsMyUEkndy1TDP').trim();

function upsertEnvLine(filePath, key, value) {
	const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
	const lines = existing ? existing.split(/\r?\n/) : [];
	let updated = false;
	const next = lines.map((line) => {
		if (line.startsWith(`${key}=`)) {
			updated = true;
			return `${key}=${value}`;
		}
		return line;
	});
	if (!updated) next.push(`${key}=${value}`);
	fs.writeFileSync(filePath, `${next.filter(Boolean).join('\n')}\n`, 'utf8');
}

function encryptN8nCredential(plainText, encryptionKey) {
	const salt = crypto.randomBytes(8);
	const password = Buffer.concat([Buffer.from(encryptionKey, 'binary'), salt]);
	const hash1 = crypto.createHash('md5').update(password).digest();
	const hash2 = crypto.createHash('md5').update(Buffer.concat([hash1, password])).digest();
	const iv = crypto.createHash('md5').update(Buffer.concat([hash2, password])).digest();
	const key = Buffer.concat([hash1, hash2]);
	const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
	const encrypted = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final()]);
	return Buffer.concat([Buffer.from('Salted__'), salt, encrypted]).toString('base64');
}

async function saveCredential(loginInfo) {
	const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
	if (!config?.encryptionKey) {
		throw new Error(`Missing encryptionKey in ${CONFIG_PATH}`);
	}

	const payload = JSON.stringify({
		cookie: JSON.stringify(loginInfo.cookie || []),
		imei: loginInfo.imei || '',
		userAgent: loginInfo.userAgent || '',
		proxy: '',
	});
	const encrypted = encryptN8nCredential(payload, config.encryptionKey);

	await new Promise((resolve, reject) => {
		const db = new sqlite3.Database(DB_PATH);
		db.run(
			`update credentials_entity
			 set data = ?,
			     name = ?,
			     updatedAt = STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')
			 where id = ?`,
			[
				encrypted,
				'Zalo API Credentials',
				TARGET_CREDENTIAL_ID,
			],
			function onRun(err) {
				if (err) {
					db.close();
					reject(err);
					return;
				}
				const changed = this.changes;
				db.close();
				if (!changed) {
					reject(new Error(`Credential ${TARGET_CREDENTIAL_ID} not found in database`));
					return;
				}
				resolve();
			},
		);
	});
	upsertEnvLine(ENV_LOCAL_PATH, 'ZALO_BRIDGE_CREDENTIAL_ID', TARGET_CREDENTIAL_ID);
	return { id: TARGET_CREDENTIAL_ID };
}

async function runLoginFlow() {
	console.log(`[zalo-login] Starting QR login flow. QR file will be written to: ${QR_PATH}`);
	const zalo = new Zalo({ selfListen: true, logging: true });
	let loginInfo;
	let finishResolve;
	let finishReject;
	const finishPromise = new Promise((resolve, reject) => {
		finishResolve = resolve;
		finishReject = reject;
	});

	const qrReadyPromise = new Promise((resolve, reject) => {
		zalo
			.loginQR({ qrPath: QR_PATH }, async (event) => {
				switch (event.type) {
					case 0:
						fs.writeFileSync(QR_PATH, Buffer.from(event.data.image, 'base64'));
						console.log('[zalo-login] QR generated. Scan it with your phone.');
						resolve({ qrBase64: event.data.image });
						break;
					case 1:
						console.log('[zalo-login] QR expired.');
						reject(new Error('QR expired'));
						finishReject(new Error('QR expired'));
						event.actions.abort();
						break;
					case 2:
						console.log(`[zalo-login] QR scanned by: ${event.data?.display_name ?? 'unknown'}`);
						break;
					case 3:
						console.log('[zalo-login] QR declined on phone.');
						reject(new Error('QR declined'));
						finishReject(new Error('QR declined'));
						event.actions.abort();
						break;
					case 4:
						loginInfo = {
							cookie: event.data?.cookie || [],
							imei: event.data?.imei || '',
							userAgent: event.data?.userAgent || '',
						};
						try {
							const saved = await saveCredential(loginInfo);
							console.log(`[zalo-login] Saved credential ${saved.id} into clone database and updated .env.local`);
							finishResolve(saved);
						} catch (error) {
							console.error(`[zalo-login] Failed to save credential: ${error.message}`);
							finishReject(error);
						}
						break;
					default:
						console.log(`[zalo-login] Unknown QR event type: ${event.type}`);
				}
			})
			.catch((error) => {
				reject(error);
				finishReject(error);
			});
	});

	await qrReadyPromise;
	console.log(`[zalo-login] Waiting for you to confirm login on the phone. QR path: ${QR_PATH}`);
	await finishPromise;
	console.log('[zalo-login] Login flow completed successfully.');
}

async function main() {
	while (true) {
		try {
			await runLoginFlow();
			return;
		} catch (error) {
			const message = String(error?.message ?? error);
			if (message === 'QR expired' || message === 'QR declined') {
				console.log(`[zalo-login] ${message}. Restarting with a fresh QR...`);
				continue;
			}
			throw error;
		}
	}
}

main().catch((error) => {
	console.error(`[zalo-login] ${error.stack || error.message}`);
	process.exit(1);
});
