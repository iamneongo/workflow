const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID';

const SHEETS = {
  logs: 'AI_Logs',
  attendance: 'ChamCong',
  mainMaterials: 'VatTuChinh',
  subMaterials: 'VatTuPhu',
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
    'main_material_count',
    'sub_material_count',
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
  VatTuChinh: [
    'received_at',
    'usage_date',
    'item_name',
    'sku',
    'unit',
    'quantity',
    'site',
    'team',
    'supplier',
    'cost',
    'note',
    'source_thread_id',
    'source_group_name',
    'source_sender_id',
    'source_sender_name',
    'source_message_text',
    'ai_summary',
    'ai_confidence',
  ],
  VatTuPhu: [
    'received_at',
    'usage_date',
    'item_name',
    'sku',
    'unit',
    'quantity',
    'site',
    'team',
    'supplier',
    'cost',
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
    const mainMaterialSheet = getOrCreateSheet_(spreadsheet, SHEETS.mainMaterials, HEADERS.VatTuChinh);
    const subMaterialSheet = getOrCreateSheet_(spreadsheet, SHEETS.subMaterials, HEADERS.VatTuPhu);

    const attendanceEntries = asArray_(payload.attendance_entries);
    const mainMaterialEntries = asArray_(payload.main_material_entries);
    const subMaterialEntries = asArray_(payload.sub_material_entries);
    const notesText = asArray_(payload.notes).map(toText_).filter(Boolean).join(' | ');

    appendRows_(logSheet, [
      [
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
        mainMaterialEntries.length,
        subMaterialEntries.length,
        notesText,
        toText_(payload.message_text),
        toText_(payload.raw_ai_json),
      ],
    ]);

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

    const mainMaterialRows = mainMaterialEntries.map(function(entry) {
      return materialRow_(payload, entry);
    });

    const subMaterialRows = subMaterialEntries.map(function(entry) {
      return materialRow_(payload, entry);
    });

    appendRows_(attendanceSheet, attendanceRows);
    appendRows_(mainMaterialSheet, mainMaterialRows);
    appendRows_(subMaterialSheet, subMaterialRows);

    return jsonResponse_({
      ok: true,
      message: 'Records routed successfully.',
      counts: {
        attendance: attendanceRows.length,
        main_materials: mainMaterialRows.length,
        sub_materials: subMaterialRows.length,
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

function materialRow_(payload, entry) {
  return [
    isoNow_(payload.received_at),
    toText_(entry.usage_date),
    toText_(entry.item_name),
    toText_(entry.sku),
    toText_(entry.unit),
    toNumber_(entry.quantity),
    toText_(entry.site),
    toText_(entry.team),
    toText_(entry.supplier),
    toNumber_(entry.cost),
    toText_(entry.note),
    toText_(payload.thread_id),
    toText_(payload.group_name),
    toText_(payload.sender_id),
    toText_(payload.sender_name),
    toText_(payload.message_text),
    toText_(payload.summary),
    toNumber_(payload.confidence),
  ];
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
