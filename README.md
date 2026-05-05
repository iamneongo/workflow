# n8n Zalo Attendance Starter

Repo nay dung de luu:

- workflow `n8n` dang export ra JSON
- code Google Apps Script
- script khoi dong local
- huong dan de nguoi khac clone ve va import lai

## Nen commit gi

- `workflows/*.json`
- `workflows/*.gs`
- `start-n8n.ps1`
- `stop-n8n.ps1`
- `package.json`
- `package-lock.json`
- `README.md`
- `scripts/*.ps1`

## Khong nen commit gi

- thu muc `.n8n/`
- file `database.sqlite`
- credentials export da `--decrypted`
- file log
- QR image dang nhap Zalo
- API key, session, cookie, webhook secret

## Clone ve dung lai

1. Clone repo.
2. Chay `npm install`.
3. Chay `./start-attendance-stack.ps1`.
4. Tao owner account tren local n8n neu la may moi.
5. Tao lai credentials trong n8n:
   - `Zalo API Credentials`
   - `Google Gemini API Local`
   - cac credential khac neu workflow can
6. Import workflow JSON trong thu muc `workflows/`.
7. Copy code Apps Script `.gs` len Google Apps Script cua tung nguoi va deploy Web App URL rieng.
8. Sua lai node URL/credential neu ten credential khac may goc.

## Ban dang chay on dinh hien tai

- `scripts/zalo-webhook-bridge.js`
- `start-zalo-bridge.ps1`
- `start-attendance-stack.ps1`
- `workflows/attendance-queue-processor-clean.json`
- `workflows/gia-phu-attendance-dopost-addon.gs`

Kien truc hien tai:

- `zca-js bridge` nghe tin nhan Zalo lien tuc
- bridge ghi thang raw message vao queue SQLite
- workflow `Attendance Queue Processor Clean` trong `n8n` quet queue moi phut
- Gemini parse tin nhan cham cong
- Apps Script ghi vao `Data_ChamCong`

## Workflow hien co

- `workflows/zalo-ai-attendance-to-appscript.json`
- `workflows/zalo-attendance-queue-listener.json`
- `workflows/attendance-queue-to-ai-appscript.json`
- `workflows/attendance-queue-processor-clean.json`
- `workflows/zalo-ai-router-to-appscript.json`

## Cach cap nhat workflow len GitHub

Neu ban da sua workflow trong UI `n8n`, chay:

```powershell
./scripts/export-workflows.ps1
```

Script nay se export tat ca workflow dang co thanh cac file JSON rieng trong `workflows/exported/`.

Ban co the:

- giu `workflows/exported/` lam backup may-phat-sinh
- va giu cac file trong `workflows/` lam ban da dat ten/on dinh de team de import

## Luu y ve credentials

Workflow JSON chi nen luu `credential name/id` tham chieu. Bi mat that su van nam trong local DB cua tung nguoi.

Neu nguoi khac clone repo:

- ho khong can DB cua ban
- ho can tu tao credentials cua ho
- sau do map lai credential trong UI

## Push len GitHub

Neu thu muc nay chua la git repo, chay:

```powershell
git init -b main
git add .
git commit -m "Initial n8n workflow repo"
git remote add origin <github-repo-url>
git push -u origin main
```

## File huong dan them

- [README-vi.md](D:/Coding/Server/n8n-local-stable/workflows/README-vi.md)
- [README-zalo-ai-router-vi.md](D:/Coding/Server/n8n-local-stable/workflows/README-zalo-ai-router-vi.md)
- [google-sheet-attendance-webapp.gs](D:/Coding/Server/n8n-local-stable/workflows/google-sheet-attendance-webapp.gs)

# workflow
