const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();
const { Zalo, ThreadType } = require('zca-js');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.ZALO_BRIDGE_DB_PATH || path.join(ROOT, '.n8n', '.n8n', 'database.sqlite');
const CONFIG_PATH = process.env.ZALO_BRIDGE_CONFIG_PATH || path.join(ROOT, '.n8n', '.n8n', 'config');
const CREDENTIAL_ID = process.env.ZALO_BRIDGE_CREDENTIAL_ID || 'ZiSsMyUEkndy1TDP';
const QUEUE_TABLE =
	process.env.ZALO_BRIDGE_QUEUE_TABLE || 'data_table_user_dad3ca9f-2474-4abc-bbf8-51e85f81eafa';

let activeApi;
let replyPollTimer;
let typingPollTimer;
const processingAckByThread = new Map();

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

function looksLikeFullAttendanceMessage(text) {
	const source = String(text ?? '').trim();
	if (!source) return false;
	const hasProject = /^\s*(ct|công\s*trình)/im.test(source);
	const hasDate = /(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})\/(\d{4})/.test(source);
	const hasShift = /\b(buổi|ca)\b[\s.:_-]*(sáng|chiều|tối|đêm|ngày)/i.test(source);
	const hasWorkerLine = /^\s*\d+[.)]\s*\S+/m.test(source);
	return hasProject && hasDate && hasShift && hasWorkerLine;
}

function supersedeOlderPendingRows(threadId, currentQueueKey, messageText) {
	if (!looksLikeFullAttendanceMessage(messageText)) {
		return Promise.resolve(0);
	}

	const sql = `
		update "${QUEUE_TABLE}"
		set status = 'ignored',
			processed_at = ?,
			summary = ?,
			last_error = '',
			updatedAt = ?
		where thread_id = ?
			and queue_key != ?
			and coalesce(status, '') = 'pending'
	`;
	const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
	const summary = 'Tin pending cũ trong cùng thread đã được bỏ qua để ưu tiên bản chấm công đầy đủ mới hơn.';

	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(DB_PATH);
		db.run(sql, [now, summary, now, String(threadId ?? ''), String(currentQueueKey ?? '')], function onRun(err) {
			db.close();
			if (err) {
				reject(err);
				return;
			}

			resolve(this.changes || 0);
		});
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

			if (!(this.changes > 0)) {
				resolve({
					inserted: false,
					queueKey,
					threadId,
					messageId,
					rowId: 0,
					superseded: 0,
				});
				return;
			}

			const rowId = this.lastID;
			supersedeOlderPendingRows(threadId, queueKey, text.trim())
				.then((superseded) => {
					resolve({
						inserted: true,
						queueKey,
						threadId,
						messageId,
						rowId,
						superseded,
					});
				})
				.catch(reject);
		});
	});
}

function ensureReplyColumns() {
	const columns = [
		['zalo_reply_sent', 'BOOLEAN'],
		['zalo_reply_text', 'TEXT'],
		['zalo_replied_at', 'DATETIME'],
		['zalo_reply_error', 'TEXT'],
		['zalo_reply_attempts', 'REAL'],
	];

	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(DB_PATH);
		db.all(`pragma table_info("${QUEUE_TABLE}")`, (err, rows) => {
			if (err) {
				db.close();
				reject(err);
				return;
			}

			const existingColumns = new Set(rows.map((row) => row.name));
			const missingColumns = columns.filter(([name]) => !existingColumns.has(name));

			const addNextColumn = (index = 0) => {
				if (index >= missingColumns.length) {
					db.close();
					resolve();
					return;
				}

				const [name, type] = missingColumns[index];
				db.run(`alter table "${QUEUE_TABLE}" add column "${name}" ${type}`, (alterError) => {
					if (alterError) {
						db.close();
						reject(alterError);
						return;
					}

					addNextColumn(index + 1);
				});
			};

			addNextColumn();
		});
	});
}

function parseLegacyReplyText(appscriptResponse) {
	if (typeof appscriptResponse !== 'string' || !appscriptResponse.trim()) {
		return '';
	}

	try {
		const parsed = JSON.parse(appscriptResponse);
		const clarificationQuestion = String(
			parsed?.clarification_question ??
			parsed?.question ??
			parsed?.validation?.clarification_question ??
			parsed?.validation?.question ??
			'',
		).trim();
		if (clarificationQuestion) {
			return clarificationQuestion;
		}

		const savedCount = Number(parsed?.counts?.attendance ?? parsed?.validation?.counts?.attendance ?? 0);
		const targetSheet = String(parsed?.targetSheet ?? '').trim();
		const projectCode = String(parsed?.projectCode ?? parsed?.validation?.projectCode ?? '').trim();
		const rowNos = Array.isArray(parsed?.rowNos) ? parsed.rowNos.filter((rowNo) => rowNo !== null && rowNo !== undefined) : [];
		const valid = parsed?.validation?.valid ?? parsed?.valid;

		if (parsed?.ok === true && (valid !== false) && (savedCount > 0 || rowNos.length > 0)) {
			const parts = [`Đã lưu chấm công thành công${savedCount > 0 ? `: ${savedCount} dòng` : ''}`];
			if (targetSheet) parts.push(`sheet ${targetSheet}`);
			if (projectCode) parts.push(`mã ${projectCode}`);
			if (rowNos.length > 0) parts.push(`dòng ${rowNos.join(', ')}`);
			return `${parts.join(' - ')}.`;
		}

		return '';
	} catch (_error) {
		return '';
	}
}

function cleanText(value) {
	return String(value ?? '').trim();
}

function parseJsonSafe(value, fallback) {
	try {
		const parsed = JSON.parse(value);
		return parsed ?? fallback;
	} catch (_error) {
		return fallback;
	}
}

function formatViDate(value) {
	const text = cleanText(value);
	if (!text) return '';
	const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (isoMatch) return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
	const viMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (viMatch) return `${viMatch[1].padStart(2, '0')}/${viMatch[2].padStart(2, '0')}/${viMatch[3]}`;
	return text;
}

function normalizeShiftLabel(value) {
	const text = cleanText(value);
	const lower = text.toLowerCase();
	if (lower.includes('sang') || lower.includes('sáng')) return 'Sáng';
	if (lower.includes('chieu') || lower.includes('chiều')) return 'Chiều';
	if (lower.includes('toi') || lower.includes('tối')) return 'Tối';
	if (lower.includes('dem') || lower.includes('đêm')) return 'Đêm';
	if (lower.includes('ngay') || lower.includes('ngày')) return 'Ngày';
	return text;
}

function joinVietnameseList(values) {
	const list = [...new Set(values.map(cleanText).filter(Boolean))];
	if (list.length <= 1) return list[0] || '';
	if (list.length === 2) return `${list[0]} và ${list[1]}`;
	return `${list.slice(0, -1).join(', ')} và ${list[list.length - 1]}`;
}

function humanizeLabel(value) {
	const text = cleanText(value);
	if (!text) return '';
	return text.charAt(0).toLocaleUpperCase('vi-VN') + text.slice(1);
}

function normalizeProjectLabel(value) {
	const text = cleanText(value);
	if (!text) return '';

	const withoutPrefix = text
		.replace(/^c(t|ông\s*tr(ì|i)nh)\s*/i, '')
		.replace(/^ct\s*/i, '')
		.trim();

	return humanizeLabel(withoutPrefix || text);
}

function extractProjectLabelFromSummary(summary) {
	const text = cleanText(summary);
	if (!text) return '';

	const match = text.match(/công trình\s+(.+?)(?:\s+ngày|\s+buổi|\s+ca|,|$)/i);
	if (!match) return '';
	return normalizeProjectLabel(match[1]);
}

function hangMucFromScopeKeys(parsed) {
	const scopeKeys = Array.isArray(parsed?.validation?.scopeKeys) ? parsed.validation.scopeKeys : parsed?.scopeKeys;
	if (!Array.isArray(scopeKeys)) return '';
	const labels = scopeKeys
		.map((key) => cleanText(key).split('||').pop())
		.map(humanizeLabel)
		.filter(Boolean);
	return labels.length === 1 ? labels[0] : '';
}

function naturalSavedAttendanceReply(parsed, row) {
	const entries = parseJsonSafe(row?.attendance_json || '[]', []);
	const attendanceEntries = Array.isArray(entries) ? entries : [];
	const savedCount = Number(parsed?.counts?.attendance ?? parsed?.validation?.counts?.attendance ?? 0);
	const rowNos = Array.isArray(parsed?.rowNos) ? parsed.rowNos.filter((rowNo) => rowNo !== null && rowNo !== undefined) : [];
	const valid = parsed?.validation?.valid ?? parsed?.valid;
	const names = joinVietnameseList(attendanceEntries.map((entry) => entry?.employee_name));
	const shifts = [...new Set(attendanceEntries.map((entry) => normalizeShiftLabel(entry?.shift)).filter(Boolean))];
	const dates = [...new Set(attendanceEntries.map((entry) => formatViDate(entry?.work_date)).filter(Boolean))];
	const scopeHangMuc = hangMucFromScopeKeys(parsed);
	const tasks = scopeHangMuc
		? [scopeHangMuc]
		: [...new Set(attendanceEntries.map((entry) => cleanText(entry?.task || entry?.site)).filter(Boolean))];
	const summaryProject = extractProjectLabelFromSummary(row?.summary);
	const projectNames = [...new Set([
		summaryProject,
		...attendanceEntries.map((entry) => normalizeProjectLabel(entry?.site)),
	].filter(Boolean))];
	const projectCode = cleanText(parsed?.projectCode ?? parsed?.validation?.projectCode);
	const warnings = Array.isArray(parsed?.validation?.warnings) ? parsed.validation.warnings : [];
	const sameDayShiftWarnings = warnings.filter((warning) => warning?.type === 'employee_other_shift_same_day');

	const countText = savedCount > 0 ? `${savedCount} dòng` : `${rowNos.length} dòng`;
	const shiftText = shifts.length === 1 ? ` buổi ${shifts[0]}` : (shifts.length > 1 ? ` các buổi ${joinVietnameseList(shifts)}` : '');
	const dateText = dates.length === 1 ? ` ngày ${dates[0]}` : (dates.length > 1 ? ` trong ${dates.length} ngày` : '');
	const taskText = tasks.length === 1 ? ` ở hạng mục ${tasks[0]}` : '';
	const projectText = projectNames.length === 1
		? ` cho công trình ${projectNames[0]}`
		: (projectCode ? ` cho công trình ${projectCode}` : '');
	const warningText = sameDayShiftWarnings.length
		? ' Mình thấy có người đã có ca khác cùng ngày, bạn kiểm tra lại nếu cần nhé.'
		: '';

	if (parsed?.ok === true && parsed?.duplicate === true) {
		if (names) {
			return `Tin này mình đã xử lý trước đó rồi: chấm công${shiftText}${dateText} cho ${names}${taskText}${projectText} đã có trong app nhé.`;
		}
		return 'Tin này mình đã xử lý trước đó rồi, dữ liệu đã có trong app nhé.';
	}

	if (parsed?.ok !== true || valid === false || (savedCount <= 0 && rowNos.length === 0)) {
		return '';
	}

	if (names) {
		return `Đã chấm công${shiftText}${dateText} cho ${names}${taskText}${projectText}. Mình đã lưu vào app rồi nhé.${warningText}`;
	}

	return `Đã lưu chấm công thành công ${countText}${projectText}. Mình đã cập nhật lên app rồi nhé.${warningText}`;
}

function parseReplyText(appscriptResponse, row = {}) {
	if (typeof appscriptResponse !== 'string' || !appscriptResponse.trim()) {
		return '';
	}

	try {
		const parsed = JSON.parse(appscriptResponse);
		const clarificationQuestion = String(
			parsed?.clarification_question ??
			parsed?.question ??
			parsed?.validation?.clarification_question ??
			parsed?.validation?.question ??
			'',
		).trim();
		if (clarificationQuestion) {
			return clarificationQuestion;
		}

		return naturalSavedAttendanceReply(parsed, row);
	} catch (_error) {
		return '';
	}
}

function getPendingZaloReplies() {
	const sql = `
		select id, thread_id, message_text, summary, attendance_json, appscript_response,
			coalesce(zalo_reply_attempts, 0) as zalo_reply_attempts
		from "${QUEUE_TABLE}"
		where coalesce(zalo_reply_sent, 0) = 0
			and coalesce(zalo_reply_attempts, 0) < 3
			and coalesce(appscript_response, '') != ''
			and coalesce(status, '') in ('done', 'needs_review', 'clarification_sent')
		order by id desc
		limit 10
	`;

	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(DB_PATH);
		db.all(sql, (err, rows) => {
			db.close();
			if (err) {
				reject(err);
				return;
			}

			resolve(rows);
		});
	});
}

function getPendingTypingThreads() {
	const sql = `
		select distinct thread_id
		from "${QUEUE_TABLE}"
		where coalesce(status, '') = 'pending'
			and coalesce(message_text, '') != ''
			and createdAt >= datetime('now', '-10 minutes')
		order by id desc
		limit 10
	`;

	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(DB_PATH);
		db.all(sql, (err, rows) => {
			db.close();
			if (err) {
				reject(err);
				return;
			}

			resolve(rows.map((row) => String(row.thread_id || '')).filter(Boolean));
		});
	});
}

async function sendTypingForThread(threadId) {
	if (!activeApi || !threadId) {
		return;
	}

	try {
		await activeApi.sendTypingEvent(String(threadId), ThreadType.Group).catch(() => undefined);
	} catch (_error) {
		// best effort only
	}
}

async function sendProcessingAck(threadId) {
	if (!activeApi || !threadId) {
		return;
	}

	const now = Date.now();
	const lastSentAt = Number(processingAckByThread.get(String(threadId)) || 0);
	if (now - lastSentAt < 15000) {
		return;
	}

	processingAckByThread.set(String(threadId), now);

	try {
		await activeApi.sendMessage(
			{ msg: 'Đã nhận tin, mình đang xử lý chấm công cho bạn...' },
			String(threadId),
			ThreadType.Group,
		);
	} catch (_error) {
		// best effort only
	}
}

function markZaloReplySent(rowId, replyText) {
	const sql = `
		update "${QUEUE_TABLE}"
		set zalo_reply_sent = 1,
			zalo_reply_text = ?,
			zalo_replied_at = ?,
			zalo_reply_error = '',
			zalo_reply_attempts = coalesce(zalo_reply_attempts, 0) + 1,
			updatedAt = ?
		where id = ?
	`;
	const now = new Date().toISOString().replace('T', ' ').replace('Z', '');

	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(DB_PATH);
		db.run(sql, [replyText, now, now, rowId], (err) => {
			db.close();
			if (err) {
				reject(err);
				return;
			}

			resolve();
		});
	});
}

function markZaloReplyFailed(rowId, error) {
	const sql = `
		update "${QUEUE_TABLE}"
		set zalo_reply_error = ?,
			zalo_reply_attempts = coalesce(zalo_reply_attempts, 0) + 1,
			updatedAt = ?
		where id = ?
	`;
	const now = new Date().toISOString().replace('T', ' ').replace('Z', '');

	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(DB_PATH);
		db.run(sql, [String(error?.message ?? error), now, rowId], (err) => {
			db.close();
			if (err) {
				reject(err);
				return;
			}

			resolve();
		});
	});
}

function updateQueueRowAfterConversation(rowId, result) {
	const sql = `
		update "${QUEUE_TABLE}"
		set status = ?,
			processed_at = ?,
			summary = ?,
			attendance_json = ?,
			needs_human_review = ?,
			confidence = ?,
			appscript_response = ?,
			last_error = '',
			updatedAt = ?
		where id = ?
	`;
	const now = new Date().toISOString().replace('T', ' ').replace('Z', '');

	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(DB_PATH);
		db.run(
			sql,
			[
				String(result?.status ?? 'ignored'),
				result?.processed_at ?? now,
				String(result?.summary ?? ''),
				String(result?.attendance_json ?? ''),
				result?.needs_human_review ? 1 : 0,
				Number(result?.confidence ?? 0),
				String(result?.appscript_response ?? ''),
				now,
				rowId,
			],
			(err) => {
				db.close();
				if (err) {
					reject(err);
					return;
				}
				resolve();
			},
		);
	});
}

function markQueueRowAsNeedsReview(rowId, error) {
	const responsePayload = {
		mode: 'clarification_request',
		source: 'bridge_fallback',
		question: 'Mình đang xử lý chậm ở bước hiểu ngữ cảnh. Bạn gửi lại giúp mình theo mẫu: Công trình + Ngày + Buổi + danh sách nhân sự nhé.',
		notes: [String(error?.message ?? error)],
	};
	const result = {
		status: 'needs_review',
		processed_at: new Date().toISOString(),
		summary: 'Bridge fallback: chuyển sang needs_review để tránh block hàng đợi.',
		attendance_json: '',
		needs_human_review: true,
		confidence: 0,
		appscript_response: JSON.stringify(responsePayload),
		reply_text: responsePayload.question,
	};
	return updateQueueRowAfterConversation(rowId, result).then(() => result);
}

async function processQueuedMessageNow(rowId, payload) {
	const contextUrl = String(process.env.OPENCLAW_CONTEXT_URL ?? 'http://127.0.0.1:20129/analyze').trim().replace(/\/analyze$/i, '/handle');
	try {
		const response = await fetch(contextUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		const text = await response.text();
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error(`OpenClaw handle returned invalid JSON: ${error.message}`);
		}
		if (!parsed?.ok || !parsed?.result) {
			throw new Error(parsed?.error || 'OpenClaw handle did not return a result');
		}
		await updateQueueRowAfterConversation(rowId, parsed.result);
		return parsed.result;
	} catch (error) {
		return markQueueRowAsNeedsReview(rowId, error);
	}
}

async function sendPendingZaloReplies() {
	if (!activeApi) {
		return;
	}

	const rows = await getPendingZaloReplies();
	for (const row of rows) {
		const replyText = parseReplyText(row.appscript_response, row);
		if (!replyText) {
			continue;
		}

		try {
			await activeApi.sendTypingEvent(String(row.thread_id), ThreadType.Group).catch(() => undefined);
			await activeApi.sendMessage({ msg: replyText }, String(row.thread_id), ThreadType.Group);
			await markZaloReplySent(row.id, replyText);
			log(`Sent Zalo reply for queue row ${row.id}`);
		} catch (error) {
			await markZaloReplyFailed(row.id, error);
			log(`Failed to send Zalo reply for queue row ${row.id}: ${error.message}`);
		}
	}
}

async function sendTypingIndicators() {
	if (!activeApi) {
		return;
	}

	const threadIds = await getPendingTypingThreads();
	for (const threadId of threadIds) {
		await sendTypingForThread(threadId);
	}
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

	await ensureReplyColumns();

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
			void sendTypingForThread(result.threadId);
			void sendProcessingAck(result.threadId);

			const conversationResult = await processQueuedMessageNow(result.rowId, {
				thread_id: String(message?.threadId ?? ''),
				group_name: String(message?.data?.dName ?? ''),
				sender_id: String(message?.data?.uidFrom ?? ''),
				sender_name: String(message?.data?.displayName ?? message?.data?.dName ?? ''),
				message_text: String(message?.data?.content ?? '').trim(),
				message_ts: String(message?.data?.ts ?? ''),
				queue_key: String(result.queueKey ?? ''),
			});

			const replyText = cleanText(conversationResult?.reply_text);
			if (replyText) {
				try {
					await activeApi.sendTypingEvent(String(result.threadId), ThreadType.Group).catch(() => undefined);
					await activeApi.sendMessage({ msg: replyText }, String(result.threadId), ThreadType.Group);
					await markZaloReplySent(result.rowId, replyText);
					log(`Sent immediate Zalo reply for queue row ${result.rowId}`);
				} catch (replyError) {
					await markZaloReplyFailed(result.rowId, replyError);
					log(`Failed to send immediate Zalo reply for queue row ${result.rowId}: ${replyError.message}`);
				}
			}
		} catch (error) {
			log(`Failed to queue message: ${error.message}`);
		}
	});

	activeApi.listener.start();
	replyPollTimer = setInterval(() => {
		void sendPendingZaloReplies().catch((error) => log(`Reply poll failed: ${error.message}`));
	}, 5000);
	typingPollTimer = setInterval(() => {
		void sendTypingIndicators().catch((error) => log(`Typing poll failed: ${error.message}`));
	}, 4000);
	void sendPendingZaloReplies().catch((error) => log(`Initial reply poll failed: ${error.message}`));
	void sendTypingIndicators().catch((error) => log(`Initial typing poll failed: ${error.message}`));
	log('Zalo listener started');
}

async function shutdown(signal) {
	log(`Received ${signal}, stopping bridge`);
	try {
		if (activeApi?.listener) {
			activeApi.listener.stop();
		}
		if (replyPollTimer) {
			clearInterval(replyPollTimer);
		}
		if (typingPollTimer) {
			clearInterval(typingPollTimer);
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
