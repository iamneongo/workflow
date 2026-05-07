const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const sqlite3 = require('sqlite3').verbose();

const PORT = Number(process.env.OPENCLAW_CONTEXT_PORT || 20129);
const HOST = process.env.OPENCLAW_CONTEXT_HOST || '127.0.0.1';
const OPENCLAW_LAUNCH = resolveOpenClawLaunch();
const REQUEST_TIMEOUT_MS = Number(process.env.OPENCLAW_CONTEXT_TIMEOUT_MS || 15000);
const MAX_BODY_BYTES = Number(process.env.OPENCLAW_CONTEXT_MAX_BODY_BYTES || 1024 * 1024);
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.OPENCLAW_CONTEXT_DB_PATH || path.join(ROOT, '.n8n', '.n8n', 'database.sqlite');
const QUEUE_TABLE =
  process.env.OPENCLAW_CONTEXT_QUEUE_TABLE || 'data_table_user_dad3ca9f-2474-4abc-bbf8-51e85f81eafa';
const APPS_SCRIPT_URL =
  process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbyzC-qw38puhlm5btycJs6ohYXArbRWBF7j70o0zU4MeHCWaoKjXM4BN4XXZXveHsgD/exec';
const STATE_DIR = path.join(ROOT, '.runtime');
const STATE_PATH = path.join(STATE_DIR, 'openclaw-thread-state.json');

function resolveOpenClawLaunch() {
  if (process.env.OPENCLAW_BIN && fs.existsSync(process.env.OPENCLAW_BIN)) {
    return {
      command: process.execPath,
      prefixArgs: [process.env.OPENCLAW_BIN],
      display: process.env.OPENCLAW_BIN,
    };
  }

  const appData = process.env.APPDATA || '';
  const moduleEntrypoint = path.join(appData, 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');
  if (fs.existsSync(moduleEntrypoint)) {
    return {
      command: process.execPath,
      prefixArgs: [moduleEntrypoint],
      display: moduleEntrypoint,
    };
  }

  return {
    command: 'openclaw',
    prefixArgs: [],
    display: 'openclaw',
  };
}

function log(message, extra) {
  const stamp = new Date().toISOString();
  if (extra === undefined) {
    console.log(`[openclaw-context] ${stamp} ${message}`);
    return;
  }
  console.log(`[openclaw-context] ${stamp} ${message}`, extra);
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function truncateText(value, max = 240) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function stripVietnamese(value) {
  return cleanText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function uniqueStrings(values) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadThreadStateMap() {
  try {
    ensureStateDir();
    if (!fs.existsSync(STATE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function saveThreadStateMap(stateMap) {
  ensureStateDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(stateMap, null, 2), 'utf8');
}

function getThreadState(threadId) {
  const stateMap = loadThreadStateMap();
  return stateMap[threadId] || {
    recent_turns: [],
    pending_clarification: null,
    last_analysis: null,
    updated_at: '',
  };
}

function setThreadState(threadId, state) {
  const stateMap = loadThreadStateMap();
  stateMap[threadId] = state;
  saveThreadStateMap(stateMap);
}

function sanitizeSessionId(threadId) {
  const raw = cleanText(threadId);
  if (!raw) {
    return `workflow_zalo__anon__${crypto.randomUUID()}`;
  }

  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return `workflow_zalo__${safe || 'thread'}`;
}

function withDb(callback) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        reject(err);
      }
    });
    callback(db, resolve, reject);
  });
}

function getRecentThreadHistory(threadId, limit = 8) {
  if (!cleanText(threadId)) return Promise.resolve([]);
  const sql = `
    select id, thread_id, sender_name, message_text, status, summary,
      coalesce(zalo_reply_text, '') as zalo_reply_text,
      processed_at, message_ts
    from "${QUEUE_TABLE}"
    where thread_id = ?
    order by id desc
    limit ?
  `;

  return withDb((db, resolve, reject) => {
    db.all(sql, [cleanText(threadId), Number(limit)], (err, rows) => {
      db.close();
      if (err) {
        reject(err);
        return;
      }

      const history = [];
      for (const row of [...rows].reverse()) {
        const userText = cleanText(row.message_text);
        if (userText) {
          history.push({
            role: 'user',
            text: userText,
            ts: cleanText(row.message_ts),
            row_id: row.id,
          });
        }
        const assistantText = cleanText(row.zalo_reply_text);
        if (assistantText) {
          history.push({
            role: 'assistant',
            text: assistantText,
            ts: cleanText(row.processed_at),
            row_id: row.id,
            status: cleanText(row.status),
          });
        }
      }

      resolve(history.slice(-(limit * 2)));
    });
  });
}

function getLatestClarificationContext(threadId) {
  if (!cleanText(threadId)) return Promise.resolve(null);
  const sql = `
    select id, summary, attendance_json, appscript_response, zalo_reply_text, processed_at
    from "${QUEUE_TABLE}"
    where thread_id = ?
      and coalesce(zalo_reply_text, '') != ''
    order by id desc
    limit 6
  `;

  return withDb((db, resolve, reject) => {
    db.all(sql, [cleanText(threadId)], (err, rows) => {
      db.close();
      if (err) {
        reject(err);
        return;
      }

      const found = rows.find((row) => cleanText(row.zalo_reply_text).includes('?'));
      if (!found) {
        resolve(null);
        return;
      }

      let draftEntries = [];
      try {
        draftEntries = summarizeEntries(JSON.parse(found.attendance_json || '[]'));
      } catch (_error) {
        draftEntries = [];
      }

      const parsedResponse = parseJsonSafe(found.appscript_response, {});
      const validation = parsedResponse?.validation || {};
      const conflicts = Array.isArray(parsedResponse?.conflicts)
        ? parsedResponse.conflicts
        : (Array.isArray(validation?.conflicts) ? validation.conflicts : []);

      const actualMissingFields = getMissingFieldsFromDraft(draftEntries);
      resolve({
        question: cleanText(found.zalo_reply_text),
        summary: cleanText(found.summary),
        draft_entries: draftEntries,
        missing_fields: actualMissingFields.length
          ? actualMissingFields
          : inferMissingFieldsFromQuestion(cleanText(found.zalo_reply_text), found.appscript_response),
        conflicts,
        validation,
        notes: ['Hydrated from latest assistant clarification in queue history.'],
        asked_at: cleanText(found.processed_at),
      });
    });
  });
}

function normalizeJsonText(text) {
  return String(text ?? '')
    .replace(/^```json\s*/i, '')
    .replace(/^```/i, '')
    .replace(/```$/i, '')
    .trim();
}

function extractBalancedObject(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  if (start === -1) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return '';
}

function summarizeEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      employee_name: truncateText(entry?.employee_name, 80),
      work_date: cleanText(entry?.work_date),
      shift: cleanText(entry?.shift),
      site: truncateText(entry?.site, 80),
      task: truncateText(entry?.task, 80),
      hours: Number(entry?.hours ?? 0),
      overtime_hours: Number(entry?.overtime_hours ?? 0),
      status: cleanText(entry?.status),
      note: truncateText(entry?.note, 120),
    }))
    .filter((entry) => entry.employee_name || entry.work_date || entry.site || entry.task);
}

function parseJsonSafe(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch (_error) {
    return fallback;
  }
}

function dedupeTurns(turns) {
  return (Array.isArray(turns) ? turns : []).filter((turn, index, list) => {
    const key = `${cleanText(turn?.role)}::${cleanText(turn?.ts)}::${cleanText(turn?.text)}`;
    return list.findIndex((candidate) => {
      const candidateKey = `${cleanText(candidate?.role)}::${cleanText(candidate?.ts)}::${cleanText(candidate?.text)}`;
      return candidateKey === key;
    }) === index;
  });
}

function isLikelyFollowupReply(messageText) {
  const text = cleanText(messageText);
  if (!text) return false;
  if (looksLikeFullAttendanceMessage(text)) return false;
  const lineCount = text.split(/\r?\n/).filter((line) => cleanText(line)).length;
  return lineCount <= 2 && text.length <= 120;
}

function looksLikeFullAttendanceMessage(text) {
  const source = cleanText(text);
  if (!source) return false;
  const hasProject = /^\s*(ct|công\s*trình)/im.test(source);
  const hasDate = /(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})\/(\d{4})/.test(source);
  const hasShift = /\b(buổi|ca)\b[\s.:_-]*(sáng|chiều|tối|đêm|ngày)/i.test(source);
  const hasWorkerLine = /^\s*\d+[.)]\s*\S+/m.test(source);
  return hasProject && hasDate && hasShift && hasWorkerLine;
}

function buildPrompt(payload, context = {}) {
  const recentTurns = Array.isArray(context.recentTurns) ? context.recentTurns : [];
  const pendingClarification = context.pendingClarification || null;
  const lastAnalysis = context.lastAnalysis || null;
  const existingAttendance = Array.isArray(context.existingAttendance) ? context.existingAttendance : [];
  const followupReply = isLikelyFollowupReply(payload?.message_text);
  const historyTurns = followupReply ? recentTurns.slice(-3) : recentTurns.slice(-6);
  const relevantAttendance = followupReply ? existingAttendance.slice(0, 4) : existingAttendance.slice(0, 8);
  const pendingDraftEntries = summarizeEntries(pendingClarification?.draft_entries).slice(0, 4);
  const instructions = [
    'You are a Vietnamese Zalo attendance context engine.',
    'Return one minified JSON object only.',
    'The JSON must use these top-level keys: action, question, summary, document_type, confidence, needs_human_review, attendance_entries, notes.',
    'Each attendance entry must use these keys: employee_name, work_date, shift, site, task, hours, overtime_hours, status, note.',
    'Use prior turns from this same session to resolve short follow-up replies like đúng, không, ok, Tầng 2, or a date-only reply.',
    'If there is a pending clarification, assume the new user message is answering that question unless the new user message is clearly a brand-new attendance message.',
    'Reason over the current user message, the pending clarification, the last structured draft, and the recent thread history before deciding.',
    'Your job is to collect enough information to save attendance correctly, not to force the user into a rigid syntax.',
    'Treat the common shorthand attendance format as valid when it already contains project or site, date, shift, and at least one numbered worker line.',
    'Text after a comma in a worker line is usually the task, hạng mục, or location and should be reused as task if present.',
    'Sáng and Chiều default to 0.5 attendance units when no units are specified. Cả ngày defaults to 1.',
    'If the new message only adds one missing field, merge it into the prior structured draft instead of asking from the beginning again.',
    'Use existing attendance context to detect likely duplicates, already-recorded shifts, and same-day conflicts before deciding to save.',
    'Ask exactly one short clarification question only when required, and ask only for the next missing or conflicting piece of information.',
    'Never ignore a short reply when there is a pending clarification unless it is clearly unrelated chatter.',
    'If irrelevant, use action ignore.',
  ].join(' ');

  return [
    `INSTRUCTIONS=${instructions}`,
    `THREAD_ID=${cleanText(payload.thread_id)}`,
    `GROUP_NAME=${cleanText(payload.group_name)}`,
    `SENDER_ID=${cleanText(payload.sender_id)}`,
    `SENDER_NAME=${cleanText(payload.sender_name)}`,
    `MESSAGE_TS=${cleanText(payload.message_ts)}`,
    `IS_FOLLOWUP_REPLY=${followupReply ? 'true' : 'false'}`,
    `PENDING_CLARIFICATION=${JSON.stringify({
      question: truncateText(pendingClarification?.question, 220),
      draft_entries: pendingDraftEntries,
      summary: truncateText(pendingClarification?.summary, 220),
      missing_fields: Array.isArray(pendingClarification?.missing_fields) ? pendingClarification.missing_fields : [],
      notes: Array.isArray(pendingClarification?.notes) ? pendingClarification.notes.map((note) => truncateText(note, 120)) : [],
    })}`,
    `LAST_ANALYSIS=${JSON.stringify({
      action: cleanText(lastAnalysis?.action),
      summary: truncateText(lastAnalysis?.summary, 220),
      attendance_entries: summarizeEntries(lastAnalysis?.attendance_entries),
      notes: Array.isArray(lastAnalysis?.notes) ? lastAnalysis.notes.map((note) => truncateText(note, 120)) : [],
    })}`,
    `EXISTING_ATTENDANCE_CONTEXT=${JSON.stringify(relevantAttendance.map((item) => ({
      employee_name: truncateText(item.employee_name, 80),
      work_date: cleanText(item.work_date),
      shift: cleanText(item.shift),
      site: truncateText(item.site, 80),
      task: truncateText(item.task, 80),
      summary: truncateText(item.summary, 160),
      processed_at: cleanText(item.processed_at),
    })))}`,
    `RECENT_THREAD_HISTORY=${JSON.stringify(historyTurns.map((turn) => ({
      role: cleanText(turn?.role),
      text: truncateText(turn?.text, 220),
      ts: cleanText(turn?.ts),
    })))}`,
    `USER_MESSAGE=${truncateText(payload.message_text, 1000).replace(/\r?\n/g, ' | ')}`,
  ].join(' || ');
}

function parseDateFromMessage(messageText) {
  const text = cleanText(messageText);
  let match = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return '';
  const day = match[1].padStart(2, '0');
  const month = match[2].padStart(2, '0');
  return `${match[3]}-${month}-${day}`;
}

function parseShiftFromMessage(messageText) {
  const text = stripVietnamese(messageText).toLowerCase();
  if (/\bbuoi\b[^\n]*\bsang\b/.test(text) || /\bca\s*sang\b/.test(text)) return 'Sáng';
  if (/\bbuoi\b[^\n]*\bchieu\b/.test(text) || /\bca\s*chieu\b/.test(text)) return 'Chiều';
  if (/\bca\s*ngay\b/.test(text) || /\bca\s*ca\s*ngay\b/.test(text)) return 'Cả ngày';
  return '';
}

function parseSiteFromMessage(messageText) {
  const lines = cleanText(messageText).split(/\r?\n/).map((line) => cleanText(line)).filter(Boolean);
  if (!lines.length) return '';
  return lines[0]
    .replace(/^c(t|ông\s*tr(ì|i)nh)\s*/i, '')
    .replace(/^ct\s*/i, '')
    .replace(/[:.-]+$/g, '')
    .trim();
}

function splitWorkerAndTask(rawValue) {
  const raw = cleanText(rawValue).replace(/[.]+$/g, '').trim();
  if (!raw) return { workersPart: '', task: '' };

  const taskPattern = /\b((t(ầng|ang)|l(ầu|au)|sàn|khu|phòng|p\.?|mặt\s*bằng)\s*\d+[a-zA-Z0-9-]*)\s*$/i;
  const taskMatch = raw.match(taskPattern);
  if (!taskMatch) {
    return { workersPart: raw, task: '' };
  }

  const task = cleanText(taskMatch[1]);
  let workersPart = cleanText(raw.slice(0, taskMatch.index));
  workersPart = workersPart.replace(/[,\-:]+$/g, '').trim();
  return { workersPart, task };
}

function isLikelyTaskLabel(value) {
  const text = stripVietnamese(value).toLowerCase();
  if (!text) return false;
  return /^(t(ang|ầng)|l(au|ầu)|san|khu|phong|p\.?|mat bang)\b/.test(text);
}

function parseWorkerEntries(messageText) {
  const lines = cleanText(messageText).split(/\r?\n/).map((line) => cleanText(line)).filter(Boolean);
  const entries = [];

  for (const line of lines) {
    const numbered = line.match(/^\d+[.)]\s*(.+)$/);
    if (!numbered) continue;

    const { workersPart, task } = splitWorkerAndTask(numbered[1]);
    const workers = uniqueStrings(
      workersPart
        .split(/[;,]/)
        .map((part) => cleanText(part.replace(/^[-•]+/, '')))
    );

    if (!workers.length && task) {
      entries.push({ employee_name: '', task });
      continue;
    }

    for (const worker of workers) {
      entries.push({ employee_name: worker, task });
    }
  }

  return entries;
}

function parseNamesFromMessage(messageText) {
  const parsedNames = uniqueStrings(parseWorkerEntries(messageText).map((entry) => entry.employee_name));
  if (parsedNames.length) return parsedNames;

  const text = cleanText(messageText).replace(/[.]+$/g, '');
  if (!text || text.includes('\n')) return [];
  if (parseDateFromMessage(text) || parseShiftFromMessage(text)) return [];
  if (/^\s*(ct|công\s*trình)/i.test(text)) return [];
  if (isLikelyTaskLabel(text)) return [];
  return [text];
}

function buildQuestionForMissingField(field, context = {}) {
  const employee = cleanText(context.employee_name);
  const shift = cleanText(context.shift);
  const workDate = cleanText(context.work_date);
  const site = cleanText(context.site);
  const task = cleanText(context.task);
  const employeeText = employee ? ` của ${employee}` : '';
  const shiftText = shift ? ` buổi ${normalizeShiftLabel(shift).toLowerCase()}` : '';
  const dateText = workDate ? ` ngày ${formatViDate(workDate)}` : '';
  const siteText = site ? ` ở công trình ${normalizeProjectLabel(site)}` : '';
  const taskText = task ? ` tại ${task}` : '';

  if (field === 'work_date') return `Bạn cho mình xin ngày chấm công${shiftText}${employeeText}${siteText}${taskText} là ngày nào?`;
  if (field === 'shift') return `Bạn cho mình xin ca hoặc buổi làm việc${employeeText}${dateText}${siteText}${taskText} nhé?`;
  if (field === 'site') return `Bạn xác nhận giúp mình công trình${employeeText}${shiftText}${dateText}${taskText} nhé?`;
  if (field === 'employee_name') return `Bạn xác nhận giúp mình đúng họ tên nhân sự${shiftText}${dateText}${siteText}${taskText} nhé?`;
  if (field === 'task') return `Bạn xác nhận giúp mình hạng mục hoặc vị trí làm việc${employeeText}${shiftText}${dateText}${siteText} nhé?`;
  return 'Bạn xác nhận thêm giúp mình thông tin còn thiếu để mình ghi chấm công đúng nhé?';
}

function buildPartialDraftAnalysis(payload) {
  const messageText = cleanText(payload?.message_text);
  if (!messageText || !/^\s*\d+[.)]/m.test(messageText)) return null;

  const workDate = parseDateFromMessage(messageText);
  const shift = parseShiftFromMessage(messageText);
  const site = /^\s*(ct|công\s*trình)/im.test(messageText) ? parseSiteFromMessage(messageText) : '';
  const rawEntries = parseWorkerEntries(messageText);
  if (!rawEntries.length) return null;

  const attendanceEntries = rawEntries.map((entry) => {
    const taskOnlyWorker = !entry.task && isLikelyTaskLabel(entry.employee_name);
    return {
      employee_name: taskOnlyWorker ? '' : cleanText(entry.employee_name),
      work_date: workDate,
      shift,
      site,
      task: taskOnlyWorker ? cleanText(entry.employee_name) : cleanText(entry.task),
      hours: shift === 'Cả ngày' ? 1 : (shift ? 0.5 : 0),
      overtime_hours: 0,
      status: 'draft',
      note: '',
    };
  });

  const firstEntry = attendanceEntries[0] || {};
  let missingField = '';
  if (attendanceEntries.some((entry) => !cleanText(entry.employee_name))) missingField = 'employee_name';
  else if (!workDate) missingField = 'work_date';
  else if (!shift) missingField = 'shift';
  else if (!site) missingField = 'site';

  if (!missingField) return null;

  return normalizeAnalysisShape({
    action: 'ask_clarification',
    question: buildQuestionForMissingField(missingField, firstEntry),
    summary: `Đã nhận được bản nháp chấm công nhưng còn thiếu ${missingField}.`,
    document_type: 'attendance',
    confidence: 0.9,
    needs_human_review: true,
    attendance_entries: attendanceEntries,
    notes: ['Đã dùng partial-draft parser để thu thập thông tin còn thiếu theo ngữ cảnh hội thoại.'],
  });
}

function buildFastPathAnalysis(payload) {
  const messageText = cleanText(payload.message_text);
  if (!messageText) return null;
  if (!/^\s*(ct|công\s*trình)/im.test(messageText)) return null;
  if (!/^\s*\d+[.)]/m.test(messageText)) return null;

  const workDate = parseDateFromMessage(messageText);
  const shift = parseShiftFromMessage(messageText);
  const site = parseSiteFromMessage(messageText);
  const workerEntries = parseWorkerEntries(messageText);

  if (!site || !workerEntries.length) return null;
  if (workerEntries.some((entry) => !cleanText(entry.employee_name))) return null;
  if (!shift) return null;

  if (!workDate) {
    return {
      action: 'ask_clarification',
      question: `Bạn cho mình xin ngày chấm công của buổi ${shift.toLowerCase()} này là ngày nào?`,
      summary: `Tin nhắn chấm công cho công trình ${site}, buổi ${shift.toLowerCase()}, gồm ${workerEntries.length} nhân công nhưng đang thiếu ngày làm việc.`,
      document_type: 'attendance',
      confidence: 0.93,
      needs_human_review: true,
      attendance_entries: workerEntries.map((entry) => ({
        employee_name: entry.employee_name,
        work_date: '',
        shift,
        site,
        task: entry.task || '',
        hours: shift === 'Cả ngày' ? 1 : 0.5,
        overtime_hours: 0,
        status: 'pending_date',
        note: '',
      })),
      notes: ['Đã dùng fast-path parser và phát hiện thiếu ngày chấm công.'],
    };
  }

  const hours = shift === 'Cả ngày' ? 1 : 0.5;
  const attendanceEntries = workerEntries.map((entry) => ({
    employee_name: entry.employee_name,
    work_date: workDate,
    shift,
    site,
    task: entry.task || '',
    hours,
    overtime_hours: 0,
    status: 'present',
    note: '',
  }));

  const taskList = uniqueStrings(attendanceEntries.map((entry) => entry.task));
  const summaryTask = taskList.length === 1 ? `, hạng mục ${taskList[0]}` : '';

  return {
    action: 'save_attendance',
    question: '',
    summary: `Chấm công công trình ${site} ngày ${workDate} buổi ${shift.toLowerCase()} cho ${attendanceEntries.length} nhân công${summaryTask}.`,
    document_type: 'attendance',
    confidence: 0.99,
    needs_human_review: false,
    attendance_entries: attendanceEntries,
    notes: ['Đã dùng fast-path parser cho mẫu chấm công chuẩn.'],
  };
}

function inferCandidateContext(payload, pendingClarification) {
  const messageText = cleanText(payload?.message_text);
  const pendingEntries = summarizeEntries(pendingClarification?.draft_entries);
  const explicitNames = parseNamesFromMessage(messageText);
  const pendingNames = pendingEntries.map((entry) => entry.employee_name).filter(Boolean);
  const workDate = parseDateFromMessage(messageText) || cleanText(pendingEntries[0]?.work_date);
  const shift = parseShiftFromMessage(messageText) || cleanText(pendingEntries[0]?.shift);
  const site = parseSiteFromMessage(messageText) || cleanText(pendingEntries[0]?.site);
  const taskHints = uniqueStrings([
    ...parseWorkerEntries(messageText).map((entry) => cleanText(entry.task)),
    ...pendingEntries.map((entry) => cleanText(entry.task)),
  ]);

  return {
    employee_names: explicitNames.length ? explicitNames : pendingNames,
    work_date: workDate,
    shift,
    site,
    task_hints: taskHints,
  };
}

function getExistingAttendanceContext(threadId, candidate, limit = 80) {
  if (!cleanText(threadId)) return Promise.resolve([]);
  const sql = `
    select id, attendance_json, summary, processed_at
    from "${QUEUE_TABLE}"
    where thread_id = ?
      and coalesce(status, '') = 'done'
      and coalesce(attendance_json, '') != ''
    order by id desc
    limit ?
  `;

  return withDb((db, resolve, reject) => {
    db.all(sql, [cleanText(threadId), Number(limit)], (err, rows) => {
      db.close();
      if (err) {
        reject(err);
        return;
      }

      const targetNames = (candidate?.employee_names || []).map((name) => stripVietnamese(name).toLowerCase());
      const targetDate = cleanText(candidate?.work_date);
      const targetShift = cleanText(candidate?.shift);
      const targetSite = stripVietnamese(candidate?.site).toLowerCase();
      const targetTasks = (candidate?.task_hints || []).map((task) => stripVietnamese(task).toLowerCase());

      const matches = [];
      for (const row of rows) {
        let entries = [];
        try {
          entries = JSON.parse(row.attendance_json || '[]');
        } catch (_error) {
          entries = [];
        }

        for (const entry of Array.isArray(entries) ? entries : []) {
          const employeeName = cleanText(entry?.employee_name);
          const workDate = cleanText(entry?.work_date);
          const shift = cleanText(entry?.shift);
          const site = cleanText(entry?.site);
          const task = cleanText(entry?.task);
          const foldedName = stripVietnamese(employeeName).toLowerCase();
          const foldedSite = stripVietnamese(site).toLowerCase();
          const foldedTask = stripVietnamese(task).toLowerCase();

          const sameName = targetNames.length ? targetNames.includes(foldedName) : false;
          const sameDate = targetDate ? workDate === targetDate : false;
          const sameShift = targetShift ? stripVietnamese(shift).toLowerCase() === stripVietnamese(targetShift).toLowerCase() : false;
          const sameSite = targetSite ? foldedSite.includes(targetSite) || targetSite.includes(foldedSite) : false;
          const sameTask = targetTasks.length ? targetTasks.includes(foldedTask) : false;

          if (!(sameName || (sameDate && sameShift) || (sameDate && sameSite) || sameTask)) {
            continue;
          }

          matches.push({
            employee_name: employeeName,
            work_date: workDate,
            shift,
            site,
            task,
            summary: truncateText(row.summary, 180),
            processed_at: cleanText(row.processed_at),
          });
        }
      }

      const deduped = [];
      const seen = new Set();
      for (const item of matches) {
        const key = [item.employee_name, item.work_date, item.shift, item.site, item.task].join('||').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }

      resolve(deduped.slice(0, 12));
    });
  });
}

function extractMissingFields(analysis) {
  const notes = Array.isArray(analysis?.notes) ? analysis.notes.map(cleanText) : [];
  const question = cleanText(analysis?.question);
  const questionLower = stripVietnamese(question).toLowerCase();
  const fields = new Set();

  for (const note of notes) {
    const lower = stripVietnamese(note).toLowerCase();
    if (lower.includes('ngay')) fields.add('work_date');
    if (lower.includes('ca') || lower.includes('buoi')) fields.add('shift');
    if (lower.includes('hang muc') || lower.includes('tang') || lower.includes('lau')) fields.add('task');
    if (lower.includes('nhan su') || lower.includes('ho ten') || lower.includes('ten')) fields.add('employee_name');
    if (lower.includes('cong trinh') || lower.includes('site')) fields.add('site');
  }

  if (questionLower.includes('ngay')) fields.add('work_date');
  if (questionLower.includes('ca') || questionLower.includes('buoi')) fields.add('shift');
  if (questionLower.includes('hang muc') || questionLower.includes('tang') || questionLower.includes('lau')) fields.add('task');
  if (questionLower.includes('nhan su') || questionLower.includes('ho ten') || questionLower.includes('ten')) fields.add('employee_name');
  if (questionLower.includes('cong trinh')) fields.add('site');

  return [...fields];
}

function normalizeAction(value) {
  const action = stripVietnamese(value).toLowerCase();
  if (['ask_clarification', 'clarification', 'clarify', 'ask'].includes(action)) return 'ask_clarification';
  if (['save_attendance', 'save', 'record', 'insert', 'update_attendance'].includes(action)) return 'save_attendance';
  if (['ignore', 'skip', 'other'].includes(action)) return 'ignore';
  return cleanText(value);
}

function normalizeAnalysisShape(analysis) {
  const next = { ...(analysis || {}) };
  next.action = normalizeAction(next.action);
  if (typeof next.notes === 'string') {
    next.notes = [next.notes];
  } else if (!Array.isArray(next.notes)) {
    next.notes = [];
  }
  if (!Array.isArray(next.attendance_entries)) {
    next.attendance_entries = [];
  }
  next.question = cleanText(next.question || next.clarification_question);
  return next;
}

function normalizeShiftLabel(value) {
  const text = cleanText(value);
  const lower = stripVietnamese(text).toLowerCase();
  if (lower.includes('sang')) return 'Sáng';
  if (lower.includes('chieu')) return 'Chiều';
  if (lower.includes('toi')) return 'Tối';
  if (lower.includes('dem')) return 'Đêm';
  if (lower.includes('ngay')) return 'Ngày';
  return text;
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

function joinVietnameseList(values) {
  const list = [...new Set((Array.isArray(values) ? values : []).map(cleanText).filter(Boolean))];
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} và ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} và ${list[list.length - 1]}`;
}

async function postAppsScriptJson(body) {
  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`Apps Script did not return valid JSON: ${error.message}`);
  }
  if (!parsed?.ok) {
    throw new Error(parsed?.message || 'Apps Script returned ok=false');
  }
  return parsed;
}

function buildClarificationPayload(analysis, extra = {}) {
  return {
    mode: 'clarification_request',
    source: extra.source || 'openclaw',
    question: cleanText(analysis?.question) || cleanText(extra.question),
    confidence: Number(analysis?.confidence ?? extra.confidence ?? 0),
    ambiguity_flags: Array.isArray(extra.ambiguity_flags)
      ? extra.ambiguity_flags
      : Array.isArray(analysis?.ambiguity_flags)
        ? analysis.ambiguity_flags
        : [],
    notes: [
      ...((Array.isArray(analysis?.notes) ? analysis.notes : []).map(cleanText)),
      ...((Array.isArray(extra.notes) ? extra.notes : []).map(cleanText)),
    ].filter(Boolean),
    ...(extra.validation ? { validation: extra.validation } : {}),
    ...(Array.isArray(extra.conflicts) ? { conflicts: extra.conflicts } : {}),
  };
}

function buildSavedReply(attendanceEntries, parsed) {
  const names = joinVietnameseList(attendanceEntries.map((entry) => entry.employee_name));
  const shifts = [...new Set(attendanceEntries.map((entry) => normalizeShiftLabel(entry.shift)).filter(Boolean))];
  const dates = [...new Set(attendanceEntries.map((entry) => formatViDate(entry.work_date)).filter(Boolean))];
  const tasks = [...new Set(attendanceEntries.map((entry) => cleanText(entry.task)).filter(Boolean))];
  const projectNames = [...new Set(attendanceEntries.map((entry) => normalizeProjectLabel(entry.site)).filter(Boolean))];
  const shiftText = shifts.length === 1 ? ` buổi ${shifts[0]}` : '';
  const dateText = dates.length === 1 ? ` ngày ${dates[0]}` : '';
  const taskText = tasks.length === 1 ? ` ở hạng mục ${tasks[0]}` : '';
  const projectText = projectNames.length === 1 ? ` cho công trình ${projectNames[0]}` : '';
  if (names) {
    return `Đã chấm công${shiftText}${dateText} cho ${names}${taskText}${projectText}. Mình đã lưu vào app rồi nhé.`;
  }
  const count = Number(parsed?.counts?.attendance ?? 0);
  return `Đã lưu chấm công thành công${count > 0 ? ` ${count} dòng` : ''}${projectText}. Mình đã cập nhật lên app rồi nhé.`;
}

function normalizeAttendanceEntries(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    employee_name: cleanText(entry?.employee_name),
    work_date: cleanText(entry?.work_date),
    shift: cleanText(entry?.shift),
    start_time: cleanText(entry?.start_time),
    end_time: cleanText(entry?.end_time),
    hours: Number(entry?.hours ?? 0),
    overtime_hours: Number(entry?.overtime_hours ?? 0),
    site: cleanText(entry?.site),
    task: cleanText(entry?.task),
    status: cleanText(entry?.status),
    note: cleanText(entry?.note),
  })).filter((entry) => entry.employee_name || entry.work_date || entry.site || entry.task);
}

async function handleConversation(payload) {
  let analysis;
  try {
    const result = await runOpenClaw(payload);
    analysis = normalizeAnalysisShape(result.analysis);
  } catch (error) {
    analysis = normalizeAnalysisShape({
      action: 'ask_clarification',
      question: 'Mình đang xử lý chậm ở bước hiểu ngữ cảnh. Bạn gửi lại giúp mình theo mẫu: Công trình + Ngày + Buổi + danh sách nhân sự nhé.',
      summary: 'OpenClaw gặp lỗi hoặc timeout, đã chuyển sang hỏi lại để không chặn hàng đợi.',
      document_type: 'attendance',
      confidence: 0.2,
      needs_human_review: true,
      attendance_entries: [],
      notes: [`OpenClaw unavailable: ${cleanText(error?.message || error)}`],
    });
  }

  const attendanceEntries = normalizeAttendanceEntries(analysis.attendance_entries);
  const documentType = cleanText(analysis.document_type) || (attendanceEntries.length ? 'attendance' : 'other');
  const processedAt = new Date().toISOString();

  if (documentType !== 'attendance' || !attendanceEntries.length) {
    const question = cleanText(analysis.question);
    const replyText = question
      ? await generateNativeReply(payload, {
          mode: 'ask_clarification',
          pendingQuestion: getThreadState(cleanText(payload?.thread_id))?.pending_clarification?.question,
          recentTurns: getThreadState(cleanText(payload?.thread_id))?.recent_turns,
          attendanceEntries,
          missingFields: extractMissingFields(analysis),
          fallbackReply: question,
        })
      : '';
    const result = {
      status: question ? 'needs_review' : 'ignored',
      processed_at: processedAt,
      summary: cleanText(analysis.summary),
      attendance_json: JSON.stringify(attendanceEntries),
      needs_human_review: Boolean(question || analysis.needs_human_review),
      confidence: Number(analysis.confidence ?? 0),
      appscript_response: JSON.stringify(question ? buildClarificationPayload(analysis) : { skipped: true, reason: 'non-attendance-or-empty' }),
      reply_text: replyText,
    };
    updateThreadStateFromResult(payload?.thread_id, payload, result);
    return result;
  }

  if (cleanText(analysis.action) === 'ask_clarification' || analysis.needs_human_review) {
    const question = cleanText(analysis.question) || 'Mình cần bạn xác nhận thêm một chút để ghi chấm công đúng nhé.';
    const replyText = await generateNativeReply(payload, {
      mode: 'ask_clarification',
      pendingQuestion: getThreadState(cleanText(payload?.thread_id))?.pending_clarification?.question,
      recentTurns: getThreadState(cleanText(payload?.thread_id))?.recent_turns,
      attendanceEntries,
      missingFields: getMissingFieldsFromDraft(attendanceEntries),
      fallbackReply: question,
    });
    const result = {
      status: 'needs_review',
      processed_at: processedAt,
      summary: cleanText(analysis.summary),
      attendance_json: JSON.stringify(attendanceEntries),
      needs_human_review: true,
      confidence: Number(analysis.confidence ?? 0),
      appscript_response: JSON.stringify(buildClarificationPayload(analysis, { question })),
      reply_text: replyText,
    };
    updateThreadStateFromResult(payload?.thread_id, payload, result);
    return result;
  }

  const basePayload = {
    ...payload,
    mode: 'validate_attendance',
    document_type: 'attendance',
    confidence: Number(analysis.confidence ?? 0),
    needs_human_review: false,
    attendance_entries: attendanceEntries,
    summary: cleanText(analysis.summary),
    notes: Array.isArray(analysis.notes) ? analysis.notes : [],
  };

  const validation = await postAppsScriptJson(basePayload);
  if (validation.valid === false) {
    const question = cleanText(validation.clarification_question) || cleanText(analysis.question) || 'Mình thấy có dữ liệu cần xác nhận lại trước khi ghi sheet.';
    const replyText = await generateNativeReply(payload, {
      mode: 'ask_clarification',
      pendingQuestion: getThreadState(cleanText(payload?.thread_id))?.pending_clarification?.question,
      recentTurns: getThreadState(cleanText(payload?.thread_id))?.recent_turns,
      attendanceEntries,
      missingFields: getMissingFieldsFromDraft(attendanceEntries),
      validationConflicts: Array.isArray(validation.conflicts) ? validation.conflicts : [],
      validationWarnings: Array.isArray(validation.warnings) ? validation.warnings : [],
      projectName: normalizeProjectLabel(attendanceEntries[0]?.site),
      fallbackReply: question,
    });
    const result = {
      status: 'needs_review',
      processed_at: processedAt,
      summary: cleanText(analysis.summary),
      attendance_json: JSON.stringify(attendanceEntries),
      needs_human_review: true,
      confidence: Number(analysis.confidence ?? 0),
      appscript_response: JSON.stringify(buildClarificationPayload(analysis, {
        source: 'sheet_validation',
        question,
        validation,
        conflicts: Array.isArray(validation.conflicts) ? validation.conflicts : [],
        ambiguity_flags: Array.isArray(validation.conflicts)
          ? validation.conflicts.map((conflict) => cleanText(conflict?.type)).filter(Boolean)
          : [],
      })),
      reply_text: replyText,
    };
    updateThreadStateFromResult(payload?.thread_id, payload, result);
    return result;
  }

  const saved = await postAppsScriptJson({
    ...payload,
    mode: 'route_attendance',
    document_type: 'attendance',
    confidence: Number(analysis.confidence ?? 0),
    needs_human_review: false,
    attendance_entries: attendanceEntries,
    summary: cleanText(analysis.summary),
    notes: Array.isArray(analysis.notes) ? analysis.notes : [],
    validation_snapshot: validation,
  });

  const savedReply = await generateNativeReply(payload, {
    mode: 'save_confirmation',
    recentTurns: getThreadState(cleanText(payload?.thread_id))?.recent_turns,
    attendanceEntries,
    validationWarnings: Array.isArray(saved?.validation?.warnings) ? saved.validation.warnings : [],
    projectName: normalizeProjectLabel(attendanceEntries[0]?.site),
    fallbackReply: buildSavedReply(attendanceEntries, saved),
  });
  const result = {
    status: 'done',
    processed_at: processedAt,
    summary: cleanText(analysis.summary),
    attendance_json: JSON.stringify(attendanceEntries),
    needs_human_review: false,
    confidence: Number(analysis.confidence ?? 0),
    appscript_response: JSON.stringify(saved),
    reply_text: savedReply,
  };
  updateThreadStateFromResult(payload?.thread_id, payload, result);
  return result;
}

function truncateTurns(turns, limit = 16) {
  return (Array.isArray(turns) ? turns : []).slice(-limit);
}

function updateThreadState(threadId, payload, analysis, recentHistory) {
  const previous = getThreadState(threadId);
  const userTurn = {
    role: 'user',
    text: cleanText(payload.message_text),
    ts: cleanText(payload.message_ts) || new Date().toISOString(),
  };

  const mergedTurns = [
    ...truncateTurns(previous.recent_turns, 12),
    ...recentHistory.filter((turn) => cleanText(turn?.text)),
    userTurn,
  ];

  let pendingClarification = null;
  if (cleanText(analysis?.action) === 'ask_clarification' && cleanText(analysis?.question)) {
    pendingClarification = {
      question: cleanText(analysis.question),
      summary: cleanText(analysis.summary),
      draft_entries: summarizeEntries(analysis.attendance_entries),
      missing_fields: extractMissingFields(analysis),
      notes: Array.isArray(analysis.notes) ? analysis.notes.map(cleanText).filter(Boolean) : [],
      asked_at: new Date().toISOString(),
    };
  }

  const assistantTurn = cleanText(analysis?.question)
    ? {
        role: 'assistant',
        text: cleanText(analysis.question),
        ts: new Date().toISOString(),
      }
    : null;

  const lastAnalysis = {
    action: cleanText(analysis?.action),
    summary: cleanText(analysis?.summary),
    attendance_entries: summarizeEntries(analysis?.attendance_entries),
    notes: Array.isArray(analysis?.notes) ? analysis.notes.map(cleanText).filter(Boolean) : [],
  };

  setThreadState(threadId, {
    recent_turns: truncateTurns(dedupeTurns(assistantTurn ? [...mergedTurns, assistantTurn] : mergedTurns), 18),
    pending_clarification: pendingClarification,
    last_analysis: lastAnalysis,
    updated_at: new Date().toISOString(),
  });
}

function inferMissingFieldsFromQuestion(question, appscriptResponse) {
  const fields = new Set(extractMissingFields({ question }));
  const parsed = parseJsonSafe(appscriptResponse, {});
  const validation = parsed?.validation || {};
  const conflicts = Array.isArray(parsed?.conflicts)
    ? parsed.conflicts
    : (Array.isArray(validation?.conflicts) ? validation.conflicts : []);

  for (const conflict of conflicts) {
    const type = stripVietnamese(conflict?.type).toLowerCase();
    if (type.includes('unknown_staff')) fields.add('employee_name');
    if (type.includes('hang_muc') || type.includes('scope') || type.includes('task')) fields.add('task');
    if (type.includes('date')) fields.add('work_date');
    if (type.includes('shift')) fields.add('shift');
    if (type.includes('site') || type.includes('cong_trinh')) fields.add('site');
  }

  return [...fields];
}

function normalizeComparable(value) {
  return stripVietnamese(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s/.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function selectSuggestionFromPending(messageText, pendingClarification) {
  const comparableMessage = normalizeComparable(messageText);
  const conflicts = Array.isArray(pendingClarification?.conflicts) ? pendingClarification.conflicts : [];
  const suggestions = uniqueStrings(conflicts.flatMap((conflict) => (
    Array.isArray(conflict?.suggestions) ? conflict.suggestions : []
  )));
  if (!suggestions.length || !comparableMessage) return '';

  const exact = suggestions.find((suggestion) => normalizeComparable(suggestion) === comparableMessage);
  if (exact) return exact;

  const included = suggestions.find((suggestion) => comparableMessage.includes(normalizeComparable(suggestion)));
  if (included) return included;

  const messageTokens = comparableMessage.split(' ').filter(Boolean);
  let best = '';
  let bestScore = 0;
  for (const suggestion of suggestions) {
    const suggestionTokens = normalizeComparable(suggestion).split(' ').filter(Boolean);
    const overlap = suggestionTokens.filter((token) => messageTokens.includes(token)).length;
    if (overlap > bestScore) {
      best = suggestion;
      bestScore = overlap;
    }
  }
  return bestScore > 0 ? best : '';
}

function nextMissingFieldFromDraft(entries) {
  const list = normalizeAttendanceEntries(entries);
  if (!list.length) return 'employee_name';
  if (list.some((entry) => !cleanText(entry.employee_name))) return 'employee_name';
  if (list.some((entry) => !cleanText(entry.work_date))) return 'work_date';
  if (list.some((entry) => !cleanText(entry.shift))) return 'shift';
  if (list.some((entry) => !cleanText(entry.site))) return 'site';
  if (list.some((entry) => !cleanText(entry.task))) return 'task';
  return '';
}

function getMissingFieldsFromDraft(entries) {
  const list = normalizeAttendanceEntries(entries);
  if (!list.length) return ['employee_name'];
  const fields = [];
  if (list.some((entry) => !cleanText(entry.employee_name))) fields.push('employee_name');
  if (list.some((entry) => !cleanText(entry.work_date))) fields.push('work_date');
  if (list.some((entry) => !cleanText(entry.shift))) fields.push('shift');
  if (list.some((entry) => !cleanText(entry.site))) fields.push('site');
  if (list.some((entry) => !cleanText(entry.task))) fields.push('task');
  return fields;
}

function buildMissingFieldQuestion(field, draftEntries) {
  const firstEntry = normalizeAttendanceEntries(draftEntries)[0] || {};
  const employeeText = cleanText(firstEntry.employee_name) ? ` của ${firstEntry.employee_name}` : '';
  const shiftText = cleanText(firstEntry.shift) ? ` buổi ${normalizeShiftLabel(firstEntry.shift).toLowerCase()}` : '';
  const dateText = cleanText(firstEntry.work_date) ? ` ngày ${formatViDate(firstEntry.work_date)}` : '';
  const siteText = cleanText(firstEntry.site) ? ` ở công trình ${normalizeProjectLabel(firstEntry.site)}` : '';

  if (field === 'work_date') return `Bạn cho mình xin ngày chấm công${shiftText}${employeeText}${siteText} là ngày nào?`;
  if (field === 'shift') return `Bạn cho mình xin ca hoặc buổi làm việc${employeeText}${dateText}${siteText} nhé?`;
  if (field === 'task') return `Bạn xác nhận giúp mình hạng mục hoặc vị trí làm việc${employeeText}${shiftText}${dateText}${siteText} nhé?`;
  if (field === 'site') return `Bạn xác nhận giúp mình công trình${employeeText}${shiftText}${dateText} nhé?`;
  if (field === 'employee_name') return `Bạn xác nhận giúp mình đúng họ tên nhân sự${shiftText}${dateText}${siteText} nhé?`;
  return 'Bạn xác nhận thêm giúp mình thông tin còn thiếu để mình ghi chấm công đúng nhé?';
}

function resolvePendingClarificationLocally(payload, pendingClarification) {
  if (!pendingClarification || !cleanText(pendingClarification?.question)) return null;
  const messageText = cleanText(payload?.message_text);
  if (!isLikelyFollowupReply(messageText)) return null;

  const draftEntries = normalizeAttendanceEntries(pendingClarification?.draft_entries);
  if (!draftEntries.length) return null;

  const missingFields = new Set(
    Array.isArray(pendingClarification?.missing_fields) && pendingClarification.missing_fields.length
      ? pendingClarification.missing_fields
      : inferMissingFieldsFromQuestion(pendingClarification?.question, JSON.stringify({ conflicts: pendingClarification?.conflicts || [] }))
  );

  let changed = false;
  const resolvedFields = [];
  const workDate = parseDateFromMessage(messageText);
  const shift = parseShiftFromMessage(messageText);
  const site = parseSiteFromMessage(messageText);
  const explicitNames = parseNamesFromMessage(messageText);
  const suggestedTask = selectSuggestionFromPending(messageText, pendingClarification);
  const cleanedReply = cleanText(messageText.replace(/^l(à|a)\s+/i, '').replace(/^đúng[,.\s]*/i, '').trim());

  if (missingFields.has('work_date') && workDate) {
    draftEntries.forEach((entry) => { entry.work_date = workDate; });
    changed = true;
    resolvedFields.push('work_date');
  }

  if (missingFields.has('shift') && shift) {
    draftEntries.forEach((entry) => { entry.shift = shift; });
    changed = true;
    resolvedFields.push('shift');
  }

  if (missingFields.has('site') && site) {
    draftEntries.forEach((entry) => { entry.site = site; });
    changed = true;
    resolvedFields.push('site');
  }

  if (missingFields.has('employee_name') && explicitNames.length) {
    if (explicitNames.length === draftEntries.length) {
      draftEntries.forEach((entry, index) => { entry.employee_name = explicitNames[index]; });
      changed = true;
      resolvedFields.push('employee_name');
    } else if (explicitNames.length === 1 && draftEntries.length === 1) {
      draftEntries[0].employee_name = explicitNames[0];
      changed = true;
      resolvedFields.push('employee_name');
    }
  }

  if (missingFields.has('task')) {
    const taskValue = suggestedTask || cleanedReply;
    if (taskValue && !parseDateFromMessage(taskValue) && !parseShiftFromMessage(taskValue)) {
      draftEntries.forEach((entry) => { entry.task = taskValue; });
      changed = true;
      resolvedFields.push('task');
    }
  }

  if (!changed) return null;

  const unresolvedField = nextMissingFieldFromDraft(draftEntries);
  if (unresolvedField) {
    return normalizeAnalysisShape({
      action: 'ask_clarification',
      question: buildMissingFieldQuestion(unresolvedField, draftEntries),
      summary: `Đã hiểu thêm ${resolvedFields.join(', ')} từ câu trả lời follow-up nhưng vẫn còn thiếu ${unresolvedField}.`,
      document_type: 'attendance',
      confidence: 0.9,
      needs_human_review: true,
      attendance_entries: draftEntries,
      notes: ['Đã hợp nhất câu trả lời follow-up vào pending clarification trước đó.'],
    });
  }

  return normalizeAnalysisShape({
    action: 'save_attendance',
    question: '',
    summary: `Đã hợp nhất câu trả lời follow-up vào bản nháp chấm công trước đó và đã đủ dữ liệu để ghi.`,
    document_type: 'attendance',
    confidence: 0.96,
    needs_human_review: false,
    attendance_entries: draftEntries,
    notes: ['Đã hợp nhất câu trả lời follow-up vào pending clarification trước đó.'],
  });
}

function updateThreadStateFromResult(threadId, payload, result) {
  const cleanThreadId = cleanText(threadId);
  if (!cleanThreadId) return;

  const previous = getThreadState(cleanThreadId);
  const userTurn = {
    role: 'user',
    text: cleanText(payload?.message_text),
    ts: cleanText(payload?.message_ts) || new Date().toISOString(),
  };

  const assistantText = cleanText(result?.reply_text);
  const assistantTurn = assistantText
    ? {
        role: 'assistant',
        text: assistantText,
        ts: cleanText(result?.processed_at) || new Date().toISOString(),
      }
    : null;

  const attendanceEntries = summarizeEntries(parseJsonSafe(result?.attendance_json, []));
  const appscriptResponse = cleanText(result?.appscript_response);
  const parsedResponse = parseJsonSafe(appscriptResponse, {});
  const validation = parsedResponse?.validation || {};
  const conflicts = Array.isArray(parsedResponse?.conflicts)
    ? parsedResponse.conflicts
    : (Array.isArray(validation?.conflicts) ? validation.conflicts : []);
  const notes = uniqueStrings([
    ...((Array.isArray(parsedResponse?.notes) ? parsedResponse.notes : []).map(cleanText)),
    cleanText(result?.summary),
  ]).filter(Boolean);

  let action = 'ignore';
  if (cleanText(result?.status) === 'done') action = 'save_attendance';
  else if (cleanText(result?.status) === 'needs_review') action = 'ask_clarification';

  const pendingClarification = cleanText(result?.status) === 'needs_review' && assistantText
    ? {
        question: assistantText,
        summary: cleanText(result?.summary),
        draft_entries: attendanceEntries,
        missing_fields: (() => {
          const actualMissingFields = getMissingFieldsFromDraft(attendanceEntries);
          return actualMissingFields.length
            ? actualMissingFields
            : inferMissingFieldsFromQuestion(assistantText, appscriptResponse);
        })(),
        notes,
        conflicts,
        validation,
        asked_at: cleanText(result?.processed_at) || new Date().toISOString(),
      }
    : null;

  const mergedTurns = dedupeTurns([
    ...truncateTurns(previous.recent_turns, 14),
    userTurn,
    ...(assistantTurn ? [assistantTurn] : []),
  ]);

  setThreadState(cleanThreadId, {
    recent_turns: truncateTurns(mergedTurns, 18),
    pending_clarification: pendingClarification,
    last_analysis: {
      action,
      summary: cleanText(result?.summary),
      attendance_entries: attendanceEntries,
      notes,
    },
    updated_at: new Date().toISOString(),
  });
}

function invokeOpenClawJson(sessionId, prompt, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    log(`OpenClaw prompt length for thread ${sessionId || '(no-session)'}: ${prompt.length}`);
    const commandArgs = [
      ...OPENCLAW_LAUNCH.prefixArgs,
      'agent',
      '--local',
      '--session-id',
      sessionId,
      '--message',
      prompt,
      '--json',
    ];

    const child = spawn(OPENCLAW_LAUNCH.command, commandArgs, {
      cwd: process.cwd(),
      windowsHide: true,
      shell: false,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(new Error(`OpenClaw request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      const merged = `${stdout}\n${stderr}`.trim();
      if (code !== 0) {
        reject(new Error(`OpenClaw exited with code ${code}. ${merged || 'No output.'}`.trim()));
        return;
      }

      try {
        const outerText = extractBalancedObject(merged) || normalizeJsonText(merged);
        if (!outerText) {
          throw new Error('OpenClaw returned empty output.');
        }
        const outer = JSON.parse(outerText);
        const text = normalizeJsonText(outer?.payloads?.[0]?.text ?? '');
        if (!text) {
          throw new Error('OpenClaw returned no text payload.');
        }
        resolve({ outer, text, stdout, stderr });
      } catch (error) {
        reject(new Error(`Failed to parse OpenClaw output: ${error.message}\nstdout=${stdout}\nstderr=${stderr}`));
      }
    });
  });
}

function buildNativeReplyPrompt(options = {}) {
  const mode = cleanText(options.mode);
  const instructions = [
    'Bạn là trợ lý chấm công Zalo của doanh nghiệp xây dựng.',
    'Trả về đúng một object JSON minified với khóa duy nhất reply_text.',
    'Câu trả lời phải tự nhiên, ngắn gọn, thân thiện, không robot.',
    'Không yêu cầu người dùng gửi lại toàn bộ mẫu nếu backend đã biết bản nháp hiện tại.',
    'Nếu đang hỏi bổ sung, chỉ hỏi đúng 1 ý còn thiếu hoặc 1 xung đột cần xác nhận.',
    'Nếu đã lưu thành công, xác nhận rõ ai, ngày nào, buổi nào, hạng mục nào, công trình nào.',
    'Nếu có dữ liệu xác thực từ sheet, ưu tiên dùng nó để nói chính xác.',
  ].join(' ');

  const payload = {
    mode,
    current_user_message: cleanText(options.currentMessage),
    thread_state: {
      pending_question: cleanText(options.pendingQuestion),
      recent_turns: (Array.isArray(options.recentTurns) ? options.recentTurns : []).slice(-4).map((turn) => ({
        role: cleanText(turn?.role),
        text: truncateText(turn?.text, 180),
      })),
    },
    draft_attendance: summarizeEntries(options.attendanceEntries),
    missing_fields: Array.isArray(options.missingFields) ? options.missingFields : [],
    validation_conflicts: Array.isArray(options.validationConflicts) ? options.validationConflicts : [],
    validation_warnings: Array.isArray(options.validationWarnings) ? options.validationWarnings : [],
    project_name: cleanText(options.projectName),
    fallback_reply: cleanText(options.fallbackReply),
  };

  return `INSTRUCTIONS=${instructions} || REPLY_CONTEXT=${JSON.stringify(payload)}`;
}

async function generateNativeReply(payload, options = {}) {
  const fallbackReply = cleanText(options.fallbackReply);
  try {
    const sessionId = `${sanitizeSessionId(payload?.thread_id)}__reply`;
    const prompt = buildNativeReplyPrompt({
      ...options,
      currentMessage: payload?.message_text,
    });
    const { text } = await invokeOpenClawJson(sessionId, prompt, Math.min(REQUEST_TIMEOUT_MS, 8000));
    const parsed = parseJsonSafe(text, {});
    const replyText = cleanText(parsed?.reply_text);
    return replyText || fallbackReply;
  } catch (_error) {
    return fallbackReply;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body too large (${size} bytes)`));
        req.destroy();
        return;
      }
      raw += chunk.toString('utf8');
    });

    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });

    req.on('error', reject);
  });
}

async function runOpenClaw(payload) {
  const sessionId = sanitizeSessionId(payload.thread_id);
  const threadId = cleanText(payload.thread_id);
  const threadState = getThreadState(threadId);
  const recentHistory = await getRecentThreadHistory(threadId).catch((error) => {
    log(`Failed to read recent thread history for ${threadId}: ${error.message}`);
    return [];
  });
  const hydratedClarification = threadState?.pending_clarification || await getLatestClarificationContext(threadId).catch((error) => {
    log(`Failed to hydrate clarification context for ${threadId}: ${error.message}`);
    return null;
  });
  const localResolution = resolvePendingClarificationLocally(payload, hydratedClarification);
  if (localResolution) {
    return {
      session_id: sessionId,
      analysis: localResolution,
      raw: {
        meta: {
          agentMeta: {
            provider: 'clarification-resolver',
            model: 'thread-state-merger',
          },
        },
      },
    };
  }
  const candidateContext = inferCandidateContext(payload, hydratedClarification);
  const existingAttendance = await getExistingAttendanceContext(threadId, candidateContext).catch((error) => {
    log(`Failed to read existing attendance context for ${threadId}: ${error.message}`);
    return [];
  });

  const hasPendingClarification = Boolean(cleanText(hydratedClarification?.question));
  const fastPath = buildFastPathAnalysis(payload);
  if (fastPath) {
    if (hasPendingClarification) {
      fastPath.notes = [
        ...(Array.isArray(fastPath.notes) ? fastPath.notes : []),
        'Phát hiện tin nhắn chấm công đầy đủ nên ưu tiên fast-path thay cho pending clarification cũ.',
      ];
    }
    updateThreadState(threadId, payload, fastPath, recentHistory);
    return {
      session_id: sessionId,
      analysis: fastPath,
      raw: {
        meta: {
          agentMeta: {
            provider: 'fast-path',
            model: 'rule-parser',
          },
        },
      },
    };
  }

  const partialDraft = buildPartialDraftAnalysis(payload);
  if (partialDraft) {
    updateThreadState(threadId, payload, partialDraft, recentHistory);
    return {
      session_id: sessionId,
      analysis: partialDraft,
      raw: {
        meta: {
          agentMeta: {
            provider: 'partial-draft',
            model: 'thread-state-merger',
          },
        },
      },
    };
  }

  return new Promise((resolve, reject) => {
    const prompt = buildPrompt(payload, {
      recentTurns: recentHistory.length ? recentHistory : threadState.recent_turns,
      pendingClarification: hydratedClarification,
      lastAnalysis: threadState.last_analysis,
      existingAttendance,
    });

    invokeOpenClawJson(sessionId, prompt, REQUEST_TIMEOUT_MS)
      .then(({ outer, text }) => {
        const analysis = normalizeAnalysisShape(JSON.parse(text));
        updateThreadState(threadId, payload, analysis, recentHistory);
        resolve({
          session_id: sessionId,
          analysis,
          raw: outer,
        });
      })
      .catch(reject);
  });
}

function writeJson(res, statusCode, body) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      writeJson(res, 200, {
        status: 'ok',
        host: HOST,
        port: PORT,
        openclawBin: OPENCLAW_LAUNCH.display,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/handle') {
      const payload = await readJsonBody(req);
      const startedAt = Date.now();
      const result = await handleConversation(payload);
      writeJson(res, 200, {
        ok: true,
        result,
        meta: {
          duration_ms: Date.now() - startedAt,
          provider: 'openclaw-first',
        },
      });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/analyze') {
      writeJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    const payload = await readJsonBody(req);
    const startedAt = Date.now();
    const result = await runOpenClaw(payload);
    writeJson(res, 200, {
      ok: true,
      session_id: result.session_id,
      analysis: result.analysis,
      meta: {
        duration_ms: Date.now() - startedAt,
        provider: result.raw?.meta?.agentMeta?.provider || 'openclaw',
        model: result.raw?.meta?.agentMeta?.model || '',
      },
    });
  } catch (error) {
    log(`Request failed: ${error.message}`);
    writeJson(res, 500, {
      ok: false,
      error: error.message,
    });
  }
});

server.listen(PORT, HOST, () => {
  log(`Listening on http://${HOST}:${PORT}`);
});
