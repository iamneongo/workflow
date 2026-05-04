# Zalo -> AI Router -> Apps Script

Muc tieu:
- Doc tin nhan moi tu Zalo
- Cho AI trich xuat thong tin nghiep vu
- Tu dong route du lieu sang 3 nhom:
  - `ChamCong`
  - `VatTuChinh`
  - `VatTuPhu`
- Ghi them 1 log tong hop vao sheet `AI_Logs`

## File moi

- [zalo-ai-router-to-appscript.json](D:/Coding/Server/n8n-local-stable/workflows/zalo-ai-router-to-appscript.json)
- [google-sheet-router-webapp.gs](D:/Coding/Server/n8n-local-stable/workflows/google-sheet-router-webapp.gs)

## Cach lap nhanh

1. Import workflow [zalo-ai-router-to-appscript.json](D:/Coding/Server/n8n-local-stable/workflows/zalo-ai-router-to-appscript.json) vao `n8n`.
2. Gan credential:
   - `zaloApi` cho node `Zalo Message Trigger`
   - `googlePalmApi` cho node `Google Gemini`
3. Trong workflow, doi URL cua node `Send to Apps Script Router` thanh `Web app URL` cua Apps Script.
4. Mo project Apps Script cua ban, dan noi dung tu [google-sheet-router-webapp.gs](D:/Coding/Server/n8n-local-stable/workflows/google-sheet-router-webapp.gs).
5. Doi `YOUR_SPREADSHEET_ID` thanh Google Sheet ID that ban muon ghi du lieu vao.
6. Deploy Apps Script theo dang `Web app`:
   - `Execute as`: `Me`
   - `Who has access`: `Anyone`
7. Test bang 1 tin nhan Zalo thuc te.

## Payload AI se gui sang Apps Script

Apps Script moi nhan 1 JSON co dang:

```json
{
  "received_at": "2026-05-04T06:00:00.000Z",
  "thread_id": "123",
  "group_name": "Cong trinh A",
  "sender_id": "456",
  "sender_name": "Nguyen Van A",
  "message_text": "To B hom nay cham cong 4 nguoi, xuat 20 bao xi mang va 2 hop dinh",
  "message_ts": "1770000000000",
  "summary": "Cham cong 4 nguoi va xuat them vat tu cho Cong trinh A",
  "document_type": "mixed",
  "confidence": 0.91,
  "needs_human_review": false,
  "attendance_entries": [],
  "main_material_entries": [],
  "sub_material_entries": [],
  "attendance_count": 0,
  "main_material_count": 0,
  "sub_material_count": 0,
  "notes": [],
  "appscript_action": {
    "mode": "route_records",
    "targets": [
      "ChamCong",
      "VatTuChinh",
      "VatTuPhu"
    ]
  },
  "raw_ai_json": "{...}"
}
```

## Ghi chu thuc te

- Luong moi nay don gian hon viec branch phuc tap trong `n8n`: AI chi can tra ve JSON chuan, Apps Script se quyet dinh ghi vao sheet nao.
- Neu project Apps Script hien tai cua ban da co function `doPost`, hay merge logic tu file moi vao project do, khong nen de 2 `doPost` song song.
- Neu ten sheet thuc te cua ban khac `ChamCong`, `VatTuChinh`, `VatTuPhu`, `AI_Logs`, chi can sua object `SHEETS` trong file Apps Script.
- Neu ban muon AI nhan biet them cac nghiep vu khac nhu `tam ung`, `de nghi mua hang`, `xac nhan giao hang`, minh co the mo rong schema tiep ma khong can doi phan trigger Zalo.
