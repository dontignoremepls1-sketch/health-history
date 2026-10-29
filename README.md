# Health Archive

Independent encrypted personal health archive.

Website: https://dontignoremepls1-sketch.github.io/health-history/

The public repository contains only neutral application resources and encrypted records/documents. The password, private source and original clinical files are not included.

The app supports separate profiles, problem statuses and audit history, latest results and trends, document review, medication and symptom journals, consultation summaries and encrypted backups. Large lists use compact pages; pinned user priorities and contextual creation keep daily work focused. Binary backup containers retain encrypted document bytes without a giant base64 JSON file; legacy JSON backups remain readable. PDF extraction and OCR run locally with self-hosted dependencies and their licenses.

Genetic results have a separate searchable section. Provider statements, raw variant reviews, clinical interpretation and collection coverage retain distinct provenance. Complete and partial captures are counted separately. Saved provider text opens from its record through a bounded on-demand gzip reader; raw DNA exports remain download-only. Genetic risk labels do not create confirmed diagnoses. Original compressed exports are available as decrypted downloads after unlocking.

Records save encrypted in the browser. Optional owner-private cloud synchronization uses a separate authenticated window and encrypted-only transport. Cloud access is currently affected by a Cloudflare block; the app explains this and provides encrypted-file transfer. Backups open in an isolated session and never silently replace the main database. Downloaded originals and consultation summaries are ordinary decrypted files on the user's device. Real phone memory limits remain device dependent.

Encryption: AES-256-GCM and PBKDF2-SHA-256 with 600,000 iterations. New or changed documents get fresh random IVs. A build may reuse existing ciphertext only after authenticating it with the current key and verifying that its decrypted bytes exactly match the current source. No tracking or analytics.
