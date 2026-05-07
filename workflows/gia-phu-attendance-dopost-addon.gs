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
      var requestMode = cleanStr_(payload.mode || payload.request_mode || 'route_attendance').toLowerCase();
      var attendanceEntries = gpAiAsArray_(payload.attendance_entries);
      var threadId = cleanStr_(payload.thread_id);
      var messageTs = cleanStr_(payload.message_ts);
      var dedupeKey = threadId + '::' + messageTs;

      var logSheet = gpAiEnsureLogSheet_();

      if (requestMode !== 'validate_attendance' && dedupeKey && gpAiHasProcessedMessage_(logSheet, dedupeKey)) {
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
      var hangMucIndex = gpAiHangMucIndex_();
      var rowItems = attendanceEntries.map(function(entry) {
        return gpAiBuildChamCongRow_(payload, entry, projectCode, staffIndex, hangMucIndex);
      }).filter(function(item) {
        return item && item.row && item.row.length;
      });

      if (!rowItems.length) {
        gpAiAppendLog_(logSheet, payload, 0, 'ignored', 'no valid attendance rows after mapping', '', []);
        return gpAiJsonResponse_({
          ok: true,
          skipped: true,
          message: 'Attendance payload produced no valid rows.',
          counts: { attendance: 0 }
        });
      }

      var validation = gpAiValidateAttendancePayload_(payload, rowItems, projectCode, staffIndex);
      if (requestMode === 'validate_attendance') {
        gpAiAppendLog_(logSheet, payload, rowItems.length, validation.valid ? 'validated' : 'validation_conflict', validation.summary || '', validation.scopeKeys.join(' | '), []);
        return gpAiJsonResponse_(validation);
      }

      if (!validation.valid) {
        gpAiAppendLog_(logSheet, payload, rowItems.length, 'validation_conflict', validation.summary || '', validation.scopeKeys.join(' | '), []);
        return gpAiJsonResponse_(validation);
      }

      var grouped = gpAiGroupRowItemsByScope_(rowItems);
      var allRowNos = [];
      var clarificationResolution = gpAiClarificationResolution_(payload);
      if (clarificationResolution) {
        gpAiDeleteResolvedOtherScopeRows_(CFG.SHEETS.DATA_CHAMCONG, rowItems, clarificationResolution);
      }
      grouped.forEach(function(group) {
        var previous = gpAiFindLatestScopeLog_(logSheet, threadId, group.scopeKey);
        if (previous && previous.rowNos.length) {
          gpAiDeleteAttendanceRowsByLog_(CFG.SHEETS.DATA_CHAMCONG, previous.rowNos, group.scopeKey);
        }

        var appended = appendConfiguredRowsSafe_(CFG.SHEETS.DATA_CHAMCONG, OPTIONAL_HEADERS[CFG.SHEETS.DATA_CHAMCONG], group.rows);
        allRowNos = allRowNos.concat(appended.rowNos || []);
        gpAiAppendLog_(logSheet, payload, group.rows.length, 'saved', 'saved to Data_ChamCong', group.scopeKey, appended.rowNos || []);
      });

      return gpAiJsonResponse_({
        ok: true,
        message: 'Attendance records saved successfully.',
        counts: {
          attendance: rowItems.length
        },
        projectCode: projectCode,
        rowNos: allRowNos,
        targetSheet: CFG.SHEETS.DATA_CHAMCONG,
        validation: validation
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
  var foldIndex = {};
  var records = [];
  staffMasterRows_().forEach(function(row) {
    var name = cleanStr_(row[1]) || cleanStr_(row[0]);
    if (!name) return;
    var record = {
      id: cleanStr_(row[0]),
      name: name,
      team: cleanStr_(row[2]),
      pos: cleanStr_(row[3]),
      salaryDay: salaryDayValue_(row[4])
    };
    records.push(record);
    index[name.toLowerCase()] = record;
    var folded = gpAiFoldVi_(name);
    if (folded && !foldIndex[folded]) foldIndex[folded] = [];
    if (folded) foldIndex[folded].push(record);
  });
  index.__foldIndex = foldIndex;
  index.__records = records;
  return index;
}

function gpAiHangMucIndex_() {
  var index = {};
  var foldIndex = {};
  var records = [];
  var catalog = masterCatalog_(CFG.SHEETS.MASTER_HANGMUC) || [];
  catalog.forEach(function(item) {
    var name = cleanStr_(item && item.name);
    if (!name) return;
    var record = {
      id: cleanStr_(item && item.id),
      name: name,
      note: cleanStr_(item && item.note)
    };
    records.push(record);
    index[name.toLowerCase()] = record;
    var folded = gpAiFoldVi_(name);
    if (folded && !foldIndex[folded]) foldIndex[folded] = [];
    if (folded) foldIndex[folded].push(record);
  });
  index.__foldIndex = foldIndex;
  index.__records = records;
  return index;
}

function gpAiNormalizeSpaces_(value) {
  return cleanStr_(value).replace(/\s+/g, ' ').trim();
}

function gpAiFoldVi_(value) {
  return gpAiNormalizeSpaces_(value)
    .toLowerCase()
    .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
    .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
    .replace(/[ìíịỉĩ]/g, 'i')
    .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
    .replace(/[ùúụủũưừứựửữ]/g, 'u')
    .replace(/[ỳýỵỷỹ]/g, 'y')
    .replace(/đ/g, 'd');
}

function gpAiUniq_(values) {
  var out = [];
  var seen = {};
  (values || []).forEach(function(value) {
    var text = cleanStr_(value);
    var key = gpAiFoldVi_(text);
    if (!text || seen[key]) return;
    seen[key] = true;
    out.push(text);
  });
  return out;
}

function gpAiLevenshtein_(a, b) {
  var s = cleanStr_(a);
  var t = cleanStr_(b);
  if (s === t) return 0;
  if (!s) return t.length;
  if (!t) return s.length;
  var rows = [];
  for (var i = 0; i <= t.length; i++) {
    rows[i] = [i];
  }
  for (var j = 0; j <= s.length; j++) {
    rows[0][j] = j;
  }
  for (i = 1; i <= t.length; i++) {
    for (j = 1; j <= s.length; j++) {
      var cost = t.charAt(i - 1) === s.charAt(j - 1) ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost
      );
    }
  }
  return rows[t.length][s.length];
}

function gpAiTokenizeFolded_(value) {
  return gpAiFoldVi_(value).split(/\s+/).map(function(part) {
    return cleanStr_(part);
  }).filter(Boolean);
}

function gpAiTokenPrefixMatch_(inputToken, candidateToken) {
  var a = cleanStr_(inputToken);
  var b = cleanStr_(candidateToken);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length === 1) return b.charAt(0) === a;
  if (a.length === 2) return b.indexOf(a) === 0;
  return b.indexOf(a) === 0;
}

function gpAiSuffixTokenMatchScore_(inputName, candidateName) {
  var inputTokens = gpAiTokenizeFolded_(inputName);
  var candidateTokens = gpAiTokenizeFolded_(candidateName);
  if (!inputTokens.length || !candidateTokens.length) return null;
  if (inputTokens.length > candidateTokens.length) return null;

  var start = candidateTokens.length - inputTokens.length;
  var score = 0;
  for (var i = 0; i < inputTokens.length; i++) {
    var inputToken = inputTokens[i];
    var candidateToken = candidateTokens[start + i];
    if (!gpAiTokenPrefixMatch_(inputToken, candidateToken)) {
      return null;
    }
    if (inputToken === candidateToken) score += 1.2;
    else if (inputToken.length === 1) score += 0.8;
    else score += 1;
  }
  return {
    matched: true,
    score: score / inputTokens.length,
    inputTokens: inputTokens,
    candidateTokens: candidateTokens
  };
}

function gpAiBestStaffMatch_(name, staffIndex) {
  var rawName = cleanStr_(name);
  if (!rawName) return null;

  var exact = staffIndex[rawName.toLowerCase()];
  if (exact) {
    return { record: exact, confidence: 1, reason: 'exact' };
  }

  var folded = gpAiFoldVi_(rawName);
  var foldedMatches = (staffIndex.__foldIndex && staffIndex.__foldIndex[folded]) || [];
  if (foldedMatches.length === 1) {
    return { record: foldedMatches[0], confidence: 0.98, reason: 'folded_exact' };
  }
  if (foldedMatches.length > 1) {
    return { record: foldedMatches[0], confidence: 0.9, reason: 'folded_multiple' };
  }

  var candidates = staffIndex.__records || [];
  var suffixMatches = [];
  candidates.forEach(function(record) {
    var suffixMatch = gpAiSuffixTokenMatchScore_(rawName, record.name);
    if (!suffixMatch) return;
    suffixMatches.push({
      record: record,
      confidence: suffixMatch.score >= 1.15 ? 0.96 : (suffixMatch.score >= 1 ? 0.92 : 0.85),
      reason: 'suffix_tokens',
      score: suffixMatch.score,
      tokenCount: suffixMatch.inputTokens.length
    });
  });
  suffixMatches.sort(function(a, b) {
    if (b.tokenCount !== a.tokenCount) return b.tokenCount - a.tokenCount;
    if (b.score !== a.score) return b.score - a.score;
    return cleanStr_(a.record.name).localeCompare(cleanStr_(b.record.name));
  });
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }
  if (suffixMatches.length > 1) {
    var top = suffixMatches[0];
    var second = suffixMatches[1];
    if (top.tokenCount >= 2 && (top.score - second.score) >= 0.2) {
      return top;
    }
    if (top.tokenCount >= 3 && top.score > second.score) {
      return top;
    }
  }

  var best = null;
  candidates.forEach(function(record) {
    var candidateFold = gpAiFoldVi_(record.name);
    var distance = gpAiLevenshtein_(folded, candidateFold);
    var longest = Math.max(folded.length, candidateFold.length) || 1;
    var ratio = distance / longest;
    if (!best || ratio < best.ratio) {
      best = {
        record: record,
        distance: distance,
        ratio: ratio
      };
    }
  });

  if (!best) return null;
  if (best.distance === 1 && best.ratio <= 0.2) {
    return { record: best.record, confidence: 0.9, reason: 'distance_1' };
  }
  if (best.distance <= 2 && best.ratio <= 0.18) {
    return { record: best.record, confidence: 0.8, reason: 'distance_2' };
  }
  return null;
}

function gpAiBestHangMucMatch_(name, hangMucIndex) {
  var rawName = cleanStr_(name);
  if (!rawName) return null;

  var exact = hangMucIndex[rawName.toLowerCase()];
  if (exact) {
    return { record: exact, confidence: 1, reason: 'exact' };
  }

  var folded = gpAiFoldVi_(rawName);
  var foldedMatches = (hangMucIndex.__foldIndex && hangMucIndex.__foldIndex[folded]) || [];
  if (foldedMatches.length === 1) {
    return { record: foldedMatches[0], confidence: 0.98, reason: 'folded_exact' };
  }

  var candidates = hangMucIndex.__records || [];
  var best = null;
  candidates.forEach(function(record) {
    var candidateFold = gpAiFoldVi_(record.name);
    if (candidateFold.indexOf(folded) >= 0 || folded.indexOf(candidateFold) >= 0) {
      var ratio = Math.min(folded.length, candidateFold.length) / Math.max(folded.length, candidateFold.length);
      if (!best || ratio > best.score) {
        best = {
          record: record,
          score: ratio,
          confidence: ratio >= 0.75 ? 0.94 : 0.86,
          reason: 'contains'
        };
      }
      return;
    }
    var suffixMatch = gpAiSuffixTokenMatchScore_(rawName, record.name);
    if (suffixMatch) {
      if (!best || suffixMatch.score > best.score) {
        best = {
          record: record,
          score: suffixMatch.score,
          confidence: suffixMatch.score >= 1 ? 0.9 : 0.82,
          reason: 'suffix_tokens'
        };
      }
      return;
    }
    var distance = gpAiLevenshtein_(folded, candidateFold);
    var longest = Math.max(folded.length, candidateFold.length) || 1;
    var ratioDistance = distance / longest;
    if (ratioDistance <= 0.18) {
      var score = 1 - ratioDistance;
      if (!best || score > best.score) {
        best = {
          record: record,
          score: score,
          confidence: score >= 0.9 ? 0.84 : 0.78,
          reason: 'distance'
        };
      }
    }
  });
  return best;
}

function gpAiToTitleCase_(value) {
  return gpAiNormalizeSpaces_(value).toLowerCase().split(' ').map(function(part) {
    if (!part) return '';
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(' ');
}

function gpAiNormalizeShiftKey_(value) {
  var text = gpAiNormalizeSpaces_(value).toLowerCase();
  if (!text) return '';
  if (text.indexOf('sang') >= 0 || text.indexOf('sáng') >= 0) return 'sang';
  if (text.indexOf('chieu') >= 0 || text.indexOf('chiều') >= 0) return 'chieu';
  if (text.indexOf('ngay') >= 0 || text.indexOf('ngày') >= 0) return 'ngay';
  if (text.indexOf('nua') >= 0 || text.indexOf('nửa') >= 0) return 'nua_ngay';
  return text;
}

function gpAiDisplayShift_(value) {
  var key = gpAiNormalizeShiftKey_(value);
  if (key === 'sang') return 'Sáng';
  if (key === 'chieu') return 'Chiều';
  if (key === 'ngay') return 'Cả ngày';
  if (key === 'nua_ngay') return 'Nửa ngày';
  return gpAiToTitleCase_(value);
}

function gpAiNormalizeScopeText_(value) {
  return gpAiNormalizeSpaces_(value).toLowerCase();
}

function gpAiCanonicalSite_(value) {
  return gpAiToTitleCase_(
    gpAiNormalizeSpaces_(value)
      .replace(/^ct\s+/i, '')
      .replace(/^công\s*trình\s+/i, '')
      .replace(/^cong\s*trinh\s+/i, '')
  );
}

function gpAiMessageLines_(payload, entry) {
  var lines = [];
  var pushCandidate = function(value) {
    var text = cleanStr_(value);
    if (!text) return;
    text.split(/\r?\n/).forEach(function(line) {
      var cleaned = cleanStr_(line);
      if (!cleaned) return;
      lines.push(cleaned);
    });
  };
  pushCandidate(payload && payload.message_text);
  pushCandidate(entry && entry.note);
  pushCandidate(entry && entry.task);
  pushCandidate(entry && entry.site);
  return gpAiUniq_(lines);
}

function gpAiResolveHangMuc_(payload, entry, hangMucIndex) {
  var candidates = [];
  var addCandidate = function(value, source, weight) {
    var text = cleanStr_(value);
    if (!text) return;
    candidates.push({
      text: text,
      source: source,
      weight: weight || 0
    });
  };

  addCandidate(payload && payload.hang_muc, 'payload_hang_muc', 30);
  addCandidate(entry && entry.task, 'entry_task', 25);
  addCandidate(entry && entry.site, 'entry_site', 12);
  gpAiMessageLines_(payload, entry).forEach(function(line) {
    var cleaned = line
      .replace(/^ct\s+/i, '')
      .replace(/^công\s*trình\s+/i, '')
      .replace(/^cong\s*trinh\s+/i, '')
      .replace(/^ngày\s+/i, '')
      .replace(/^buổi\.?\s+/i, '')
      .trim();
    addCandidate(cleaned, 'message_line', 10);
  });

  var best = null;
  candidates.forEach(function(candidate) {
    var match = gpAiBestHangMucMatch_(candidate.text, hangMucIndex);
    if (!match) return;
    var weightedScore = (match.confidence || 0) + ((candidate.weight || 0) / 100);
    if (!best || weightedScore > best.weightedScore) {
      best = {
        record: match.record,
        confidence: match.confidence,
        reason: match.reason,
        source: candidate.source,
        input: candidate.text,
        weightedScore: weightedScore
      };
    }
  });
  return best;
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

function gpAiBuildChamCongRow_(payload, entry, projectCode, staffIndex, hangMucIndex) {
  var name = cleanStr_(entry && entry.employee_name);
  if (!name) return null;

  var bestStaffMatch = gpAiBestStaffMatch_(name, staffIndex);
  var staff = bestStaffMatch ? bestStaffMatch.record : null;
  var salaryDay = staff ? cleanNum_(staff.salaryDay) : 0;
  var heSo = gpAiInferHeSo_(entry);
  var luongGoc = salaryDay ? Math.round(salaryDay * heSo) : 0;
  var gioOT = cleanNum_(entry && entry.overtime_hours);
  var donGiaOT = salaryDay ? (salaryDay / 8) * 1.5 : 0;
  var tienOT = gioOT ? Math.round(donGiaOT * gioOT) : 0;
  var phuCap = 0;
  var thanhTien = luongGoc + phuCap + tienOT;
  var workDate = cleanStr_(entry && entry.work_date) || isoDateOnly_(payload.received_at) || isoDateOnly_(new Date());
  var shiftText = gpAiDisplayShift_(cleanStr_(entry && entry.shift) || gpAiInferShift_(entry));
  var siteText = gpAiCanonicalSite_(cleanStr_(entry && entry.site));
  var taskText = gpAiToTitleCase_(cleanStr_(entry && entry.task));
  var hangMucMatch = gpAiResolveHangMuc_(payload, entry, hangMucIndex || gpAiHangMucIndex_());
  var hangMuc = hangMucMatch ? cleanStr_(hangMucMatch.record.name) : (taskText || siteText || gpAiToTitleCase_(cleanStr_(payload.summary) || 'AI chấm công'));
  var pos = staff ? cleanStr_(staff.pos) : '';
  var canonicalName = staff ? cleanStr_(staff.name) : gpAiToTitleCase_(name);
  var week = gpAiWeekLabelFromDate_(workDate);
  var scopeKey = [
    gpAiNormalizeScopeText_(projectCode),
    gpAiNormalizeScopeText_(workDate),
    gpAiNormalizeShiftKey_(shiftText),
    gpAiNormalizeScopeText_(hangMuc)
  ].join('||');

  return {
    scopeKey: scopeKey,
    projectCode: projectCode,
    workDate: workDate,
    shiftText: shiftText,
    hangMuc: hangMuc,
    siteText: siteText,
    taskText: taskText,
    employeeName: canonicalName,
    hangMucMatch: hangMucMatch,
    row: [
      new Date(),
      workDate,
      week,
      shiftText,
      projectCode,
      hangMuc,
      canonicalName,
      pos,
      luongGoc,
      phuCap,
      gioOT,
      tienOT,
      thanhTien,
      'Đã xác nhận',
      heSo
    ]
  };
}

function gpAiGroupRowItemsByScope_(rowItems) {
  var groupedMap = {};
  rowItems.forEach(function(item) {
    if (!groupedMap[item.scopeKey]) {
      groupedMap[item.scopeKey] = {
        scopeKey: item.scopeKey,
        rows: []
      };
    }
    groupedMap[item.scopeKey].rows.push(item.row);
  });
  return Object.keys(groupedMap).map(function(key) {
    return groupedMap[key];
  });
}

function gpAiExistingAttendanceRows_() {
  var ws = requireConfiguredSheet_(CFG.SHEETS.DATA_CHAMCONG, OPTIONAL_HEADERS[CFG.SHEETS.DATA_CHAMCONG]);
  var headerRow = findHeaderRowIndex_(ws, OPTIONAL_HEADERS[CFG.SHEETS.DATA_CHAMCONG], 5);
  var lastRow = ws.getLastRow();
  if (lastRow <= headerRow) return [];
  var values = ws.getRange(headerRow + 1, 1, lastRow - headerRow, 15).getDisplayValues();
  return values.map(function(row, idx) {
    return {
      rowNo: headerRow + 1 + idx,
      timestamp: cleanStr_(row[0]),
      workDate: cleanStr_(row[1]),
      week: cleanStr_(row[2]),
      shift: cleanStr_(row[3]),
      projectCode: cleanStr_(row[4]),
      hangMuc: cleanStr_(row[5]),
      employeeName: cleanStr_(row[6]),
      position: cleanStr_(row[7]),
      status: cleanStr_(row[13]),
      heSo: cleanStr_(row[14])
    };
  }).filter(function(item) {
    return item.projectCode || item.employeeName || item.workDate;
  });
}

function gpAiBuildConflictQuestion_(conflicts, incomingSummary) {
  if (!conflicts.length) return '';
  var first = conflicts[0];
  if (first.type === 'unknown_staff') {
    var staffSuffix = first.suggestions && first.suggestions.length ? (' Có phải là ' + first.suggestions.join(', ') + ' không?') : '';
    return 'Mình chưa thấy nhân sự "' + first.employee_name + '" trong Master_NhanSu.' + staffSuffix + ' Bạn xác nhận lại đúng họ tên giúp mình nhé?';
  }
  if (first.type === 'unknown_hangmuc') {
    var suffix = first.suggestions && first.suggestions.length ? (' Có phải là ' + first.suggestions.join(', ') + ' không?') : '';
    return 'Mình chưa xác định được hạng mục chuẩn cho "' + first.input_text + '".' + suffix + ' Bạn xác nhận lại giúp mình hạng mục để mình ghi đúng lên app nhé?';
  }
  return 'Mình thấy có xung đột với dữ liệu chấm công hiện có' + (incomingSummary ? ' cho ' + incomingSummary : '') + '. Bạn xác nhận lại giúp mình trước khi ghi nhé?';
}

function gpAiClarificationResolution_(payload) {
  if (payload && payload.clarification_resolution && typeof payload.clarification_resolution === 'object') {
    return payload.clarification_resolution;
  }
  if (payload && payload.clarificationResolution && typeof payload.clarificationResolution === 'object') {
    return payload.clarificationResolution;
  }
  return null;
}

function gpAiResolutionEmployeeNames_(resolution) {
  return gpAiAsArray_(resolution && resolution.employee_names).map(function(name) {
    return gpAiFoldVi_(name);
  }).filter(Boolean);
}

function gpAiResolutionMatchesItem_(resolution, item) {
  if (!resolution || !item || !item.row) return false;
  var resolutionType = cleanStr_(resolution.type);
  if (['hang_muc_confirmed', 'keep_current_scope_only'].indexOf(resolutionType) < 0) return false;
  var employeeNames = gpAiResolutionEmployeeNames_(resolution);
  if (employeeNames.length && employeeNames.indexOf(gpAiFoldVi_(item.row[6])) < 0) return false;
  if (cleanStr_(resolution.work_date) && cleanStr_(resolution.work_date) !== cleanStr_(item.row[1])) return false;
  if (cleanStr_(resolution.shift) && gpAiNormalizeShiftKey_(resolution.shift) !== gpAiNormalizeShiftKey_(item.row[3])) return false;
  var targetScope = gpAiNormalizeScopeText_(cleanStr_(resolution.target_scope || resolution.resolved_hang_muc));
  if (targetScope && gpAiNormalizeScopeText_(item.row[5]) !== targetScope) return false;
  return true;
}

function gpAiShouldBypassSameShiftConflict_(resolution, item, existing) {
  if (!resolution || !item || !existing) return false;
  if (!resolution.allow_replace_same_shift_conflict && cleanStr_(resolution.type) !== 'keep_current_scope_only') return false;
  if (!gpAiResolutionMatchesItem_(resolution, item)) return false;
  if (cleanStr_(existing.workDate) !== cleanStr_(item.row[1])) return false;
  if (gpAiNormalizeShiftKey_(existing.shift) !== gpAiNormalizeShiftKey_(item.row[3])) return false;
  if (gpAiFoldVi_(existing.employeeName) !== gpAiFoldVi_(item.row[6])) return false;
  return true;
}

function gpAiDeleteResolvedOtherScopeRows_(sheetName, rowItems, resolution) {
  if (!resolution || !rowItems || !rowItems.length) return;
  var ws = requireConfiguredSheet_(sheetName, OPTIONAL_HEADERS[sheetName]);
  var targetRows = gpAiExistingAttendanceRows_().filter(function(existing) {
    return rowItems.some(function(item) {
      return gpAiShouldBypassSameShiftConflict_(resolution, item, existing) &&
        gpAiNormalizeScopeText_(existing.hangMuc) !== gpAiNormalizeScopeText_(item.row[5]);
    });
  }).map(function(existing) {
    return existing.rowNo;
  }).filter(function(rowNo) {
    return Number(rowNo) >= 2;
  }).sort(function(a, b) {
    return b - a;
  });

  targetRows.forEach(function(rowNo) {
    if (rowNo <= ws.getLastRow()) ws.deleteRow(rowNo);
  });
}

function gpAiValidateAttendancePayload_(payload, rowItems, projectCode, staffIndex) {
  var existingRows = gpAiExistingAttendanceRows_();
  var clarificationResolution = gpAiClarificationResolution_(payload);
  var conflicts = [];
  var warnings = [];
  var seenPayloadKeys = {};
  var grouped = gpAiGroupRowItemsByScope_(rowItems);
  var scopeKeys = grouped.map(function(group) { return group.scopeKey; });

  rowItems.forEach(function(item) {
    if (!item.hangMucMatch || !item.hangMucMatch.record || (item.hangMucMatch.confidence || 0) < 0.78) {
      var hangMucSuggestions = (gpAiHangMucIndex_().__records || []).slice(0, 5).map(function(record) {
        return cleanStr_(record.name);
      });
      conflicts.push({
        type: 'unknown_hangmuc',
        input_text: cleanStr_(item.taskText || item.siteText || item.hangMuc),
        suggestions: hangMucSuggestions,
        severity: 'high'
      });
    }

    var employeeName = cleanStr_(item.row[6]);
    var workDate = cleanStr_(item.row[1]);
    var incomingShift = gpAiDisplayShift_(item.row[3]);
    var foldedName = gpAiFoldVi_(employeeName);
    var payloadKey = [gpAiFoldVi_(employeeName), gpAiNormalizeScopeText_(workDate), gpAiNormalizeShiftKey_(item.row[3])].join('||');
    if (seenPayloadKeys[payloadKey]) {
      warnings.push({
        type: 'duplicate_employee_in_payload',
        employee_name: employeeName,
        work_date: workDate,
        incoming_shift: incomingShift,
        severity: 'high'
      });
    }
    seenPayloadKeys[payloadKey] = true;

    var bestMatch = gpAiBestStaffMatch_(employeeName, staffIndex);
    if (!bestMatch) {
      var suggestions = ((staffIndex.__foldIndex && staffIndex.__foldIndex[foldedName]) || []).slice(0, 3).map(function(record) {
        return cleanStr_(record.name);
      });
      conflicts.push({
        type: 'unknown_staff',
        employee_name: employeeName,
        suggestions: suggestions,
        severity: suggestions.length ? 'medium' : 'high'
      });
    }
  });

  grouped.forEach(function(group) {
    var scopeRows = existingRows.filter(function(existing) {
      var existingScopeKey = [
        gpAiNormalizeScopeText_(existing.projectCode),
        gpAiNormalizeScopeText_(existing.workDate),
        gpAiNormalizeShiftKey_(existing.shift),
        gpAiNormalizeScopeText_(existing.hangMuc)
      ].join('||');
      return existingScopeKey === group.scopeKey;
    });
    if (scopeRows.length) {
      var existingNames = gpAiUniq_(scopeRows.map(function(row) {
        return gpAiToTitleCase_(row.employeeName);
      }));
      var incomingNames = gpAiUniq_(group.rows.map(function(row) {
        return gpAiToTitleCase_(row[6]);
      }));
      var existingSet = existingNames.map(gpAiFoldVi_).sort().join('|');
      var incomingSet = incomingNames.map(gpAiFoldVi_).sort().join('|');
      if (existingSet !== incomingSet || scopeRows.length !== group.rows.length) {
        warnings.push({
          type: 'existing_same_scope',
          scope_key: group.scopeKey,
          scope_label: projectCode + ' ngày ' + cleanStr_(group.rows[0][1]) + ' ca ' + gpAiDisplayShift_(group.rows[0][3]),
          existing_count: scopeRows.length,
          incoming_count: group.rows.length,
          existing_names: existingNames,
          incoming_names: incomingNames,
          severity: 'high'
        });
      } else {
        warnings.push({
          type: 'existing_same_scope',
          scope_key: group.scopeKey,
          scope_label: projectCode + ' ngày ' + cleanStr_(group.rows[0][1]) + ' ca ' + gpAiDisplayShift_(group.rows[0][3]),
          existing_count: scopeRows.length,
          incoming_count: group.rows.length,
          existing_names: existingNames,
          incoming_names: incomingNames,
          severity: 'medium'
        });
      }
    }
  });

  rowItems.forEach(function(item) {
    var employeeName = gpAiToTitleCase_(item.row[6]);
    var foldedName = gpAiFoldVi_(employeeName);
    var workDate = cleanStr_(item.row[1]);
    var incomingShiftKey = gpAiNormalizeShiftKey_(item.row[3]);
    var incomingShift = gpAiDisplayShift_(item.row[3]);
    var incomingScope = gpAiToTitleCase_(item.row[5]);
    existingRows.forEach(function(existing) {
      if (gpAiFoldVi_(existing.employeeName) !== foldedName) return;
      if (cleanStr_(existing.projectCode) !== projectCode) return;
      if (cleanStr_(existing.workDate) !== workDate) return;
      var existingShiftKey = gpAiNormalizeShiftKey_(existing.shift);
      if (existingShiftKey && incomingShiftKey && existingShiftKey !== incomingShiftKey) {
        warnings.push({
          type: 'employee_other_shift_same_day',
          employee_name: employeeName,
          work_date: workDate,
          existing_shift: gpAiDisplayShift_(existing.shift),
          incoming_shift: incomingShift,
          severity: 'medium'
        });
      }
      if (existingShiftKey === incomingShiftKey && gpAiNormalizeScopeText_(existing.hangMuc) !== gpAiNormalizeScopeText_(incomingScope)) {
        if (gpAiShouldBypassSameShiftConflict_(clarificationResolution, item, existing)) return;
        warnings.push({
          type: 'employee_other_site_same_shift',
          employee_name: employeeName,
          work_date: workDate,
          existing_scope: cleanStr_(existing.hangMuc),
          incoming_scope: incomingScope,
          severity: 'high'
        });
      }
    });
  });

  var dedupedConflicts = [];
  var seenConflictKeys = {};
  conflicts.forEach(function(conflict) {
    var key = [
      conflict.type,
      gpAiFoldVi_(conflict.employee_name || ''),
      cleanStr_(conflict.work_date || ''),
      cleanStr_(conflict.scope_key || ''),
      cleanStr_(conflict.existing_shift || ''),
      cleanStr_(conflict.incoming_shift || ''),
      cleanStr_(conflict.existing_scope || ''),
      cleanStr_(conflict.incoming_scope || '')
    ].join('||');
    if (seenConflictKeys[key]) return;
    seenConflictKeys[key] = true;
    dedupedConflicts.push(conflict);
  });

  var dedupedWarnings = [];
  var seenWarningKeys = {};
  warnings.forEach(function(warning) {
    var key = [
      warning.type,
      gpAiFoldVi_(warning.employee_name || ''),
      (warning.suggestions || []).join('|')
    ].join('||');
    if (seenWarningKeys[key]) return;
    seenWarningKeys[key] = true;
    dedupedWarnings.push(warning);
  });

  var summary = dedupedConflicts.length
    ? 'Phat hien ' + dedupedConflicts.length + ' xung dot can xac nhan truoc khi ghi sheet.'
    : (dedupedWarnings.length
      ? 'Khong co xung dot chan ghi. Co ' + dedupedWarnings.length + ' canh bao de doi chieu sau khi ghi.'
      : 'Khong phat hien xung dot voi du lieu hien co.');
  var incomingSummary = rowItems.length
    ? projectCode + ' ngày ' + cleanStr_(rowItems[0].row[1]) + ' ca ' + gpAiDisplayShift_(rowItems[0].row[3])
    : '';

  return {
    ok: true,
    mode: 'validate_attendance',
    valid: dedupedConflicts.length === 0,
    projectCode: projectCode,
    counts: { attendance: rowItems.length },
    scopeKeys: scopeKeys,
    summary: summary,
    conflicts: dedupedConflicts,
    warnings: dedupedWarnings,
    clarification_question: gpAiBuildConflictQuestion_(dedupedConflicts, incomingSummary)
  };
}

function gpAiEnsureLogSheet_() {
  var headers = [
    'received_at',
    'thread_id',
    'message_ts',
    'sender_name',
    'document_type',
    'attendance_count',
    'status',
    'note',
    'scope_key',
    'row_nos'
  ];
  var logSheet = sheetOrCreate_('AI_Logs', headers);
  var current = logSheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  var needsUpdate = false;
  for (var i = 0; i < headers.length; i++) {
    if (cleanStr_(current[i]) !== headers[i]) {
      needsUpdate = true;
      break;
    }
  }
  if (needsUpdate) {
    logSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return logSheet;
}

function gpAiFindLatestScopeLog_(logSheet, threadId, scopeKey) {
  var lastRow = logSheet.getLastRow();
  if (lastRow < 2) return null;
  var values = logSheet.getRange(2, 1, lastRow - 1, 10).getDisplayValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var row = values[i];
    if (cleanStr_(row[1]) === cleanStr_(threadId) && cleanStr_(row[8]) === cleanStr_(scopeKey) && cleanStr_(row[6]).toLowerCase() === 'saved') {
      return {
        rowNo: i + 2,
        rowNos: cleanStr_(row[9]).split(',').map(function(value) {
          return Number(cleanStr_(value));
        }).filter(function(value) {
          return value >= 2;
        })
      };
    }
  }
  return null;
}

function gpAiDeleteAttendanceRowsByLog_(sheetName, rowNos, scopeKey) {
  var ws = requireConfiguredSheet_(sheetName, OPTIONAL_HEADERS[sheetName]);
  var validRows = (rowNos || []).filter(function(rowNo) {
    return Number(rowNo) >= 2;
  }).sort(function(a, b) {
    return b - a;
  });
  validRows.forEach(function(rowNo) {
    if (rowNo > ws.getLastRow()) return;
    var row = ws.getRange(rowNo, 1, 1, 15).getDisplayValues()[0];
    var rowScopeKey = [
      gpAiNormalizeScopeText_(row[4]),
      gpAiNormalizeScopeText_(row[1]),
      gpAiNormalizeShiftKey_(row[3])
    ].join('||');
    if (rowScopeKey === scopeKey) {
      ws.deleteRow(rowNo);
    }
  });
}

function gpAiHasProcessedMessage_(logSheet, dedupeKey) {
  if (!dedupeKey) return false;
  var lastRow = logSheet.getLastRow();
  if (lastRow < 2) return false;
  var values = logSheet.getRange(2, 2, lastRow - 1, 6).getDisplayValues();
  var found = values.some(function(row) {
    var status = cleanStr_(row[5]).toLowerCase();
    if (status === 'validated' || status === 'validation_conflict') return false;
    return (cleanStr_(row[0]) + '::' + cleanStr_(row[1])) === dedupeKey;
  });
  return found;
}

function gpAiAppendLog_(logSheet, payload, count, status, note, scopeKey, rowNos) {
  appendConfiguredRowSafe_('AI_Logs', [
    'received_at',
    'thread_id',
    'message_ts',
    'sender_name',
    'document_type',
    'attendance_count',
    'status',
    'note',
    'scope_key',
    'row_nos'
  ], [
    isoOrBlank_(payload.received_at) || new Date().toISOString(),
    cleanStr_(payload.thread_id),
    cleanStr_(payload.message_ts),
    cleanStr_(payload.sender_name),
    cleanStr_(payload.document_type),
    cleanNum_(count),
    cleanStr_(status),
    cleanStr_(note),
    cleanStr_(scopeKey),
    (rowNos || []).join(',')
  ]);
}
