const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrationFiles() {
    const entries = await fs.readdir(MIGRATIONS_DIR);
    return entries.filter((name) => name.endsWith('.sql')).sort();
}

async function migrate() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    try {
        // Блокировка на время наката: параллельные контейнеры не будут применять
        // миграции одновременно.
        await client.query("SELECT pg_advisory_lock(hashtext('legion:migrations'))");
        const files = await migrationFiles();
        if (files.length === 0) throw new Error('No migration files found');
        for (const file of files) {
            const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
            await client.query(sql);
            console.log(`Applied migration: ${file}`);
        }
        console.log(`Database migrations applied: ${files.length}`);
    } finally {
        client.release();
        await pool.end();
    }
}

if (require.main === module) {
    migrate().catch((error) => {
        console.error('Database migration failed:', error.message);
        process.exitCode = 1;
    });
}

module.exports = { migrate, migrationFiles };
