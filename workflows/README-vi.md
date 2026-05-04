# Zalo -> Gemini -> Google Sheets

Muc tieu:
- Dang nhap Zalo bang QR
- Lang nghe tin nhan moi trong nhom Zalo
- Dua noi dung sang Gemini de format thanh JSON co cau truc
- Ghi moi tin nhan da xu ly thanh 1 dong trong Google Sheets

## File da tao

- [zalo-qr-login.json](D:/Coding/Server/n8n-local-stable/workflows/zalo-qr-login.json)
- [zalo-group-gemini-to-sheets.json](D:/Coding/Server/n8n-local-stable/workflows/zalo-group-gemini-to-sheets.json)
- [sheet-template.csv](D:/Coding/Server/n8n-local-stable/workflows/sheet-template.csv)

## Cach dung nhanh

1. Hoan tat man hinh setup owner cua n8n.
2. Vao `Settings -> n8n API` va tao 1 API key.
3. Tao credential `n8n Zalo Account Credential`:
   - `API Key`: API key vua tao
   - `URL`: `http://127.0.0.1:5678`
4. Import workflow `zalo-qr-login.json`.
5. Chon credential `n8nZaloApi` cho node `Zalo Login Via QR`, chay manual workflow, quet QR bang app Zalo.
6. Sau khi login xong, n8n se co them credential `zaloApi`.
7. Tao credential `Google Gemini(PaLM) Api` va paste Gemini API key.
8. Tao credential `Google Sheets OAuth2 API`.
9. Tao 1 Google Sheet moi, copy header tu `sheet-template.csv`, sau do copy `YOUR_GOOGLE_SHEET_ID`.
10. Import workflow `zalo-group-gemini-to-sheets.json`, gan 3 credential:
   - `zaloApi` cho `Zalo Message Trigger`
   - `googlePalmApi` cho `Google Gemini`
   - `googleSheetsOAuth2Api` cho `Google Sheets`
11. Sua `YOUR_GOOGLE_SHEET_ID` trong node `Google Sheets`.
12. Activate workflow.

## Minh hoa luong du lieu

Tin nhan vao nhom Zalo:

```text
Chot don 5 hop sua hat cho chi Lan, sdt 0909123456, giao 12 Le Loi Q1 truoc ngay 2026-04-22
```

Gemini tra ve JSON:

```json
{
  "thread_id": "2394859234",
  "group_name": "Don Hang Fortmart",
  "sender_id": "1122334455",
  "sender_name": "Nguyen Van A",
  "message_text": "Chot don 5 hop sua hat cho chi Lan, sdt 0909123456, giao 12 Le Loi Q1 truoc ngay 2026-04-22",
  "message_ts": 1713580215000,
  "summary": "Khach dat 5 hop sua hat, can giao truoc 2026-04-22.",
  "category": "order",
  "intent": "Dat hang moi",
  "action_required": true,
  "action_type": "new_order",
  "customer_name": "Chi Lan",
  "phone": "0909123456",
  "address": "12 Le Loi Q1",
  "product": "Sua hat",
  "quantity": 5,
  "unit": "hop",
  "amount": 0,
  "due_date": "2026-04-22",
  "priority": "high",
  "confidence": 0.93
}
```

Dong du lieu ghi vao Google Sheets:

```text
received_at | thread_id | group_name | sender_name | summary | category | action_type | customer_name | phone | address | product | quantity | due_date | priority
```

## Luu y

- Node Zalo nay dung co che gia lap Zalo Web, co rui ro bi khoa tai khoan theo chinh sach Zalo.
- `dName` tu Zalo co the la ten hien thi cua nguoi gui hoac ngu canh chat tuy tung loai message. Neu ban muon, minh co the chinh workflow sau khi ban test 1-2 tin nhan thuc te.
- Minh dang gia dinh `fortmart` cua ban la yeu cau format du lieu truoc khi ghi vao sheet. Neu ban muon format theo schema rieng cua Fortmart, minh co the sua prompt va cot sheet theo mau cua ban.
