/**
 * Additive-only Apps Script block for GiaPhu Super ERP.
 * Paste this block at the END of your existing script.
 * It does not modify current logic; it only adds web app entrypoints/helpers.
 */

function doPost(e) {
  return gpAiHandleDoPost_(e);
}

function gpAiHandleDoPost_(e) {
  try {
    return withDocLock_(function() {
      var payload = gpAiParsePostPayload_(e);
      var attendanceEntries = gpAiAsArray_(payload.attendance_entries);
      var threadId = cleanStr_(payload.thread_id);
      var messageTs = cleanStr_(payload.message_ts);
      var dedupeKey = threadId + '::' + messageTs;

      var logSheet = sheetOrCreate_('AI_Logs', [
        'received_at',
        'thread_id',
        'message_ts',
        'sender_name',
        'document_type',
        'attendance_count',
        'status',
        'note'
      ]);

      if (dedupeKey && gpAiHasProcessedMessage_(logSheet, dedupeKey)) {
        return gpAiJsonResponse_({
          ok: true,
          duplicate: true,
          message: 'Message already processed.',
          counts: { attendance: 0 }
        });
      }

      if (cleanStr_(payload.document_type).toLowerCase() !== 'attendance') {
        gpAiAppendLog_(logSheet, payload, 0, 'ignored', 'document_type is not attendance');
        return gpAiJsonResponse_({
          ok: true,
          skipped: true,
          message: 'Payload is not attendance.',
          counts: { attendance: 0 }
        });
      }

      if (!attendanceEntries.length) {
        gpAiAppendLog_(logSheet, payload, 0, 'ignored', 'attendance_entries is empty');
        return gpAiJsonResponse_({
          ok: true,
          skipped: true,
          message: 'No attendance entries to save.',
          counts: { attendance: 0 }
        });
      }

      var projectCode = effectiveProjectCode_(cleanStr_(payload.project_code || payload.ct || payload.project));
      if (!projectCode) {
        projectCode = configuredProjectCode_();
      }
      if (!projectCode) {
        throw new Error('Khong xac dinh duoc ma cong trinh de ghi Data_ChamCong.');
      }

      requireConfiguredSheet_(CFG.SHEETS.DATA_CHAMCONG, OPTIONAL_HEADERS[CFG.SHEETS.DATA_CHAMCONG]);

      var staffIndex = gpAiStaffIndex_();
      var rows = attendanceEntries.map(function(entry) {
        return gpAiBuildChamCongRow_(payload, entry, projectCode, staffIndex);
      }).filter(function(row) {
        return row && row.length;
      });

      if (!rows.length) {
        gpAiAppendLog_(logSheet, payload, 0, 'ignored', 'no valid attendance rows after mapping');
        return gpAiJsonResponse_({
          ok: true,
          skipped: true,
          message: 'Attendance payload produced no valid rows.',
          counts: { attendance: 0 }
        });
      }

      var appended = appendConfiguredRowsSafe_(CFG.SHEETS.DATA_CHAMCONG, OPTIONAL_HEADERS[CFG.SHEETS.DATA_CHAMCONG], rows);
      gpAiAppendLog_(logSheet, payload, rows.length, 'saved', 'saved to Data_ChamCong');

      return gpAiJsonResponse_({
        ok: true,
        message: 'Attendance records saved successfully.',
        counts: {
          attendance: rows.length
        },
        projectCode: projectCode,
        rowNos: appended.rowNos || [],
        targetSheet: CFG.SHEETS.DATA_CHAMCONG
      });
    });
  } catch (error) {
    return gpAiJsonResponse_({
      ok: false,
      error: String(error && error.message ? error.message : error),
      stack: error && error.stack ? String(error.stack) : ''
    });
  }
}

function gpAiParsePostPayload_(e) {
  var raw = (e && e.postData && e.postData.contents) || '{}';
  var payload = JSON.parse(raw);
  return payload && typeof payload === 'object' ? payload : {};
}

function gpAiJsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function gpAiAsArray_(value) {
  return Array.isArray(value) ? value : [];
}

function gpAiStaffIndex_() {
  var index = {};
  staffMasterRows_().forEach(function(row) {
    var name = cleanStr_(row[1]) || cleanStr_(row[0]);
    if (!name) return;
    index[name.toLowerCase()] = {
      id: cleanStr_(row[0]),
      name: name,
      team: cleanStr_(row[2]),
      pos: cleanStr_(row[3]),
      salaryDay: salaryDayValue_(row[4])
    };
  });
  return index;
}

function gpAiInferShift_(entry) {
  var shift = cleanStr_(entry && entry.shift).toLowerCase();
  if (shift) return shift;
  var hours = cleanNum_(entry && entry.hours);
  if (hours >= 8) return 'ca ngay';
  if (hours > 0 && hours <= 4) return 'ca sang';
  return '';
}

function gpAiInferHeSo_(entry) {
  var shift = gpAiInferShift_(entry);
  var hours = cleanNum_(entry && entry.hours);
  if (shift.indexOf('nua') >= 0 || shift.indexOf('sang') >= 0 || shift.indexOf('chieu') >= 0) return 0.5;
  if (hours > 0 && hours < 8) return Math.max(0.5, Math.min(1, Math.round((hours / 8) * 100) / 100));
  return 1;
}

function gpAiWeekLabelFromDate_(value) {
  var d = value ? new Date(value) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  var date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  var dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  var yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  var weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return 'W' + weekNo + '/' + date.getUTCFullYear();
}

function gpAiBuildChamCongRow_(payload, entry, projectCode, staffIndex) {
  var name = cleanStr_(entry && entry.employee_name);
  if (!name) return null;

  var staff = staffIndex[name.toLowerCase()] || null;
  var salaryDay = staff ? cleanNum_(staff.salaryDay) : 0;
  var heSo = gpAiInferHeSo_(entry);
  var luongGoc = salaryDay ? Math.round(salaryDay * heSo) : 0;
  var gioOT = cleanNum_(entry && entry.overtime_hours);
  var donGiaOT = salaryDay ? (salaryDay / 8) * 1.5 : 0;
  var tienOT = gioOT ? Math.round(donGiaOT * gioOT) : 0;
  var phuCap = 0;
  var thanhTien = luongGoc + phuCap + tienOT;
  var workDate = cleanStr_(entry && entry.work_date) || isoDateOnly_(payload.received_at) || isoDateOnly_(new Date());
  var shiftText = cleanStr_(entry && entry.shift) || gpAiInferShift_(entry);
  var hangMuc = cleanStr_(entry && entry.task) || cleanStr_(entry && entry.site) || cleanStr_(payload.summary) || 'AI chấm công';
  var pos = staff ? cleanStr_(staff.pos) : '';
  var week = gpAiWeekLabelFromDate_(workDate);

  return [
    new Date(),
    workDate,
    week,
    shiftText,
    projectCode,
    hangMuc,
    name,
    pos,
    luongGoc,
    phuCap,
    gioOT,
    tienOT,
    thanhTien,
    'Đã xác nhận',
    heSo
  ];
}

function gpAiHasProcessedMessage_(logSheet, dedupeKey) {
  if (!dedupeKey) return false;
  var lastRow = logSheet.getLastRow();
  if (lastRow < 2) return false;
  var values = logSheet.getRange(2, 2, lastRow - 1, 2).getDisplayValues();
  var found = values.some(function(row) {
    return (cleanStr_(row[0]) + '::' + cleanStr_(row[1])) === dedupeKey;
  });
  return found;
}

function gpAiAppendLog_(logSheet, payload, count, status, note) {
  appendConfiguredRowSafe_('AI_Logs', [
    'received_at',
    'thread_id',
    'message_ts',
    'sender_name',
    'document_type',
    'attendance_count',
    'status',
    'note'
  ], [
    isoOrBlank_(payload.received_at) || new Date().toISOString(),
    cleanStr_(payload.thread_id),
    cleanStr_(payload.message_ts),
    cleanStr_(payload.sender_name),
    cleanStr_(payload.document_type),
    cleanNum_(count),
    cleanStr_(status),
    cleanStr_(note)
  ]);
}
