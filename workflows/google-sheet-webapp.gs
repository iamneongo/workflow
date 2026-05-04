function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents || '{}');
    var spreadsheet = SpreadsheetApp.openById('1o-6SOlnPPA-i7oLUsmwF-gToqvZZlcaNYOK9gYh8IaY');
    var sheet = spreadsheet.getActiveSheet();

    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        'received_at',
        'thread_id',
        'group_name',
        'sender_id',
        'sender_name',
        'message_text',
        'message_ts',
        'summary',
        'category',
        'intent',
        'action_required',
        'action_type',
        'customer_name',
        'phone',
        'address',
        'product',
        'quantity',
        'unit',
        'amount',
        'due_date',
        'priority',
        'confidence',
        'raw_ai_json',
      ]);
    }

    sheet.appendRow([
      payload.received_at || new Date().toISOString(),
      payload.thread_id || '',
      payload.group_name || '',
      payload.sender_id || '',
      payload.sender_name || '',
      payload.message_text || '',
      payload.message_ts || '',
      payload.summary || '',
      payload.category || '',
      payload.intent || '',
      payload.action_required === true,
      payload.action_type || '',
      payload.customer_name || '',
      payload.phone || '',
      payload.address || '',
      payload.product || '',
      Number(payload.quantity || 0),
      payload.unit || '',
      Number(payload.amount || 0),
      payload.due_date || '',
      payload.priority || '',
      Number(payload.confidence || 0),
      payload.raw_ai_json || '',
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService
      .createTextOutput(
        JSON.stringify({
          ok: false,
          error: String(error),
        }),
      )
      .setMimeType(ContentService.MimeType.JSON);
  }
}
