const SPREADSHEET_ID = '1WQPKmUUSuqd1NOm6PbQfkgCBJ4icm8P13YD9qCzOtdk';

const SHEETS = {
  logs: 'AI_Logs',
  attendance: 'ChamCong',
};

const HEADERS = {
  AI_Logs: [
    'received_at',
    'thread_id',
    'group_name',
    'sender_id',
    'sender_name',
    'document_type',
    'summary',
    'confidence',
    'needs_human_review',
    'attendance_count',
    'notes',
    'message_text',
    'raw_ai_json',
  ],
  ChamCong: [
    'received_at',
    'work_date',
    'employee_name',
    'shift',
    'start_time',
    'end_time',
    'hours',
    'overtime_hours',
    'site',
    'task',
    'status',
    'note',
    'source_thread_id',
    'source_group_name',
    'source_sender_id',
    'source_sender_name',
    'source_message_text',
    'ai_summary',
    'ai_confidence',
  ],
};

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);

    const logSheet = getOrCreateSheet_(spreadsheet, SHEETS.logs, HEADERS.AI_Logs);
    const attendanceSheet = getOrCreateSheet_(spreadsheet, SHEETS.attendance, HEADERS.ChamCong);

    const attendanceEntries = asArray_(payload.attendance_entries);
    const notesText = asArray_(payload.notes).map(toText_).filter(Boolean).join(' | ');

    appendRows_(logSheet, [[
      isoNow_(payload.received_at),
      toText_(payload.thread_id),
      toText_(payload.group_name),
      toText_(payload.sender_id),
      toText_(payload.sender_name),
      toText_(payload.document_type),
      toText_(payload.summary),
      toNumber_(payload.confidence),
      toBoolean_(payload.needs_human_review),
      attendanceEntries.length,
      notesText,
      toText_(payload.message_text),
      toText_(payload.raw_ai_json),
    ]]);

    const attendanceRows = attendanceEntries.map(function(entry) {
      return [
        isoNow_(payload.received_at),
        toText_(entry.work_date),
        toText_(entry.employee_name),
        toText_(entry.shift),
        toText_(entry.start_time),
        toText_(entry.end_time),
        toNumber_(entry.hours),
        toNumber_(entry.overtime_hours),
        toText_(entry.site),
        toText_(entry.task),
        toText_(entry.status),
        toText_(entry.note),
        toText_(payload.thread_id),
        toText_(payload.group_name),
        toText_(payload.sender_id),
        toText_(payload.sender_name),
        toText_(payload.message_text),
        toText_(payload.summary),
        toNumber_(payload.confidence),
      ];
    });

    appendRows_(attendanceSheet, attendanceRows);

    return jsonResponse_({
      ok: true,
      message: 'Attendance records saved successfully.',
      counts: {
        attendance: attendanceRows.length,
      },
      sheets: SHEETS,
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: String(error),
      stack: error && error.stack ? String(error.stack) : '',
    });
  }
}

function getOrCreateSheet_(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
  }

  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  const currentHeaders = headerRange.getValues()[0];
  const isEmpty = currentHeaders.every(function(value) {
    return String(value || '').trim() === '';
  });

  if (isEmpty) {
    headerRange.setValues([headers]);
  }

  return sheet;
}

function appendRows_(sheet, rows) {
  if (!rows || !rows.length) {
    return;
  }

  const startRow = sheet.getLastRow() + 1;
  const columnCount = rows[0].length;
  sheet.getRange(startRow, 1, rows.length, columnCount).setValues(rows);
}

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function asArray_(value) {
  return Array.isArray(value) ? value : [];
}

function toText_(value) {
  return String(value == null ? '' : value).trim();
}

function toNumber_(value) {
  const num = Number(value || 0);
  return isFinite(num) ? num : 0;
}

function toBoolean_(value) {
  return value === true;
}

function isoNow_(value) {
  const text = toText_(value);
  return text || new Date().toISOString();
}
