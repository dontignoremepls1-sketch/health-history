# Health Archive

Independent encrypted personal health archive.

Website: https://dontignoremepls1-sketch.github.io/health-history/

The public repository contains only neutral application resources and encrypted records/documents. The password, private source and original clinical files are not included.

The app supports problem statuses and audit history, latest results and trends, document review, medication and symptom journals, consultation summaries and encrypted backups. PDF text extraction and OCR run locally using the self-hosted dependencies with their included licenses.

Records save encrypted in the browser. Optional owner-private cloud synchronization uses a separate authenticated window and encrypted-only transport. Backup files open in an isolated session and never silently replace the main database. Downloaded consultation summaries and original documents are ordinary decrypted files on the user's device.

Encryption: AES-256-GCM, PBKDF2-SHA-256 with 600,000 iterations and fresh random IVs. No tracking or analytics.
