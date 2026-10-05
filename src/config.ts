// ponytail: dotenv dep removed — node:process.loadEnvFile (Node 20.12+). Real env still wins.
try { process.loadEnvFile(); } catch { /* no .env file */ }
