# Health Archive

Independent encrypted medical-history website for GitHub Pages.

Only the neutral application interface and encrypted records/documents are stored here. The password and original files are not included in this repository. Open the website and enter the password to decrypt locally in the browser.

New records added in the interface remain encrypted in that browser. Use the encrypted backup export to transfer them to another device. Publishing an updated shared version requires rebuilding the local private source.

Encryption: AES-256-GCM with a fresh random IV; PBKDF2-SHA-256 with 600,000 iterations. No trackers, third-party runtime assets or analytics.

Website: https://dontignoremepls1-sketch.github.io/health-history/
