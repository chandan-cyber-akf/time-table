/**
 * UniSchedule - Hybrid Backend Server & SQLite Relational Database Engine
 * Built with native Node.js (node:http + node:sqlite) - zero third-party dependencies!
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'timetable.db');
const PUBLIC_DIR = __dirname;

// ============================================================================
// 1. SQLite Relational Database Initialization & Schema
// ============================================================================
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode and foreign keys for high performance and integrity
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

function initDatabaseSchema() {
  db.exec(`
    -- 1. System & Institution Settings
    CREATE TABLE IF NOT EXISTS meta_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 2. Academic Departments
    CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE
    );

    -- 3. Physical Rooms & Labs
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      building TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('lecture', 'lab', 'auditorium', 'seminar'))
    );

    -- 4. Faculty Members
    CREATE TABLE IF NOT EXISTS faculty (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      designation TEXT,
      dept TEXT,
      email TEXT,
      max_hours INTEGER DEFAULT 18,
      color TEXT DEFAULT '#4F46E5',
      FOREIGN KEY (dept) REFERENCES departments(id) ON DELETE SET NULL
    );

    -- 5. Student Batches / Classes
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      dept TEXT,
      semester INTEGER NOT NULL,
      section TEXT NOT NULL,
      student_count INTEGER DEFAULT 50,
      default_room TEXT,
      FOREIGN KEY (dept) REFERENCES departments(id) ON DELETE SET NULL,
      FOREIGN KEY (default_room) REFERENCES rooms(id) ON DELETE SET NULL
    );

    -- 6. Courses & Subjects
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      code TEXT NOT NULL,
      title TEXT NOT NULL,
      faculty_id TEXT,
      periods_per_week INTEGER DEFAULT 3,
      is_lab INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 1,
      room_type TEXT DEFAULT 'lecture',
      preferred_room TEXT,
      color TEXT DEFAULT '#3B82F6',
      FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
      FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE SET NULL,
      FOREIGN KEY (preferred_room) REFERENCES rooms(id) ON DELETE SET NULL
    );

    -- 7. Timetable Schedule Allocations
    CREATE TABLE IF NOT EXISTS timetable_entries (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      course_id TEXT NOT NULL,
      faculty_id TEXT,
      room_id TEXT NOT NULL,
      day TEXT NOT NULL,
      period_id INTEGER NOT NULL,
      is_lab INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 1,
      FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
      FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE SET NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );
  `);
}

initDatabaseSchema();

// ============================================================================
// 2. Data Access Layer & Seed Data
// ============================================================================

function loadSampleDataFromDisk() {
  const sampleFilePath = path.join(__dirname, 'js', 'sample-data.js');
  const content = fs.readFileSync(sampleFilePath, 'utf-8');
  const context = { globalThis: {} };
  vm.createContext(context);
  vm.runInContext(content, context);
  return context.SAMPLE_UNIVERSITY_DATA || context.globalThis.SAMPLE_UNIVERSITY_DATA;
}

// Read initial sample dataset from sample-data.js if DB is empty
function seedDatabaseIfEmpty() {
  const rowCount = db.prepare('SELECT COUNT(*) as count FROM departments').get().count;
  if (rowCount > 0) return; // Already seeded

  console.log('Seeding SQLite database with initial university schema and sample records...');

  try {
    const sample = loadSampleDataFromDisk();
    if (sample) {
      saveFullDatasetToSQLite(sample);
      console.log('Database successfully seeded with comprehensive university records!');
    }
  } catch (err) {
    console.error('Error seeding database:', err.message);
  }
}

function saveFullDatasetToSQLite(data) {
  // Wrap entire batch in a transaction
  db.exec('BEGIN TRANSACTION;');
  try {
    // 1. Meta Settings
    if (data.institution) {
      db.prepare('INSERT OR REPLACE INTO meta_settings(key, value) VALUES (?, ?)')
        .run('institution', JSON.stringify(data.institution));
    }
    if (data.settings) {
      db.prepare('INSERT OR REPLACE INTO meta_settings(key, value) VALUES (?, ?)')
        .run('settings', JSON.stringify(data.settings));
    }

    // 2. Clear relational tables for full sync
    db.exec('DELETE FROM timetable_entries;');
    db.exec('DELETE FROM courses;');
    db.exec('DELETE FROM batches;');
    db.exec('DELETE FROM faculty;');
    db.exec('DELETE FROM rooms;');
    db.exec('DELETE FROM departments;');

    // 3. Insert Departments
    const insertDept = db.prepare('INSERT INTO departments(id, name, code) VALUES (?, ?, ?)');
    for (const d of data.departments || []) {
      insertDept.run(d.id, d.name, d.code);
    }

    // 4. Insert Rooms
    const insertRoom = db.prepare('INSERT INTO rooms(id, name, building, capacity, type) VALUES (?, ?, ?, ?, ?)');
    for (const r of data.rooms || []) {
      insertRoom.run(r.id, r.name, r.building || '', r.capacity || 50, r.type || 'lecture');
    }

    // 5. Insert Faculty
    const insertFac = db.prepare('INSERT INTO faculty(id, name, designation, dept, email, max_hours, color) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const f of data.faculty || []) {
      insertFac.run(f.id, f.name, f.designation || '', f.dept || null, f.email || '', f.maxHours || 18, f.color || '#4F46E5');
    }

    // 6. Insert Batches
    const insertBatch = db.prepare('INSERT INTO batches(id, name, dept, semester, section, student_count, default_room) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const b of data.batches || []) {
      insertBatch.run(b.id, b.name, b.dept || null, b.semester || 1, b.section || 'A', b.studentCount || 50, b.defaultRoom || null);
    }

    // 7. Insert Courses
    const insertCourse = db.prepare(`
      INSERT INTO courses(id, batch_id, code, title, faculty_id, periods_per_week, is_lab, duration, room_type, preferred_room, color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of data.courses || []) {
      insertCourse.run(
        c.id, c.batchId, c.code, c.title, c.facultyId || null,
        c.periodsPerWeek || 3, c.isLab ? 1 : 0, c.duration || 1,
        c.roomType || 'lecture', c.preferredRoom || null, c.color || '#3B82F6'
      );
    }

    // 8. Insert Timetable Entries (if any)
    const insertTT = db.prepare(`
      INSERT INTO timetable_entries(id, batch_id, course_id, faculty_id, room_id, day, period_id, is_lab, duration)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of data.timetable || []) {
      insertTT.run(
        t.id, t.batchId, t.courseId, t.facultyId || null, t.roomId,
        t.day, t.periodId, t.isLab ? 1 : 0, t.duration || 1
      );
    }

    db.exec('COMMIT;');
    return { success: true };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function getFullDatasetFromSQLite() {
  // Settings
  let institution = { name: "Apex Institute of Technology & Science", term: "Fall Semester 2026-2027", departmentDefault: "dept_cse" };
  let settings = null;

  const instRow = db.prepare("SELECT value FROM meta_settings WHERE key = 'institution'").get();
  if (instRow) {
    try { institution = JSON.parse(instRow.value); } catch(e) {}
  }

  const settRow = db.prepare("SELECT value FROM meta_settings WHERE key = 'settings'").get();
  if (settRow) {
    try { settings = JSON.parse(settRow.value); } catch(e) {}
  }

  // Departments
  const departments = db.prepare('SELECT id, name, code FROM departments').all();

  // Rooms
  const rooms = db.prepare('SELECT id, name, building, capacity, type FROM rooms').all();

  // Faculty
  const facultyRaw = db.prepare('SELECT id, name, designation, dept, email, max_hours as maxHours, color FROM faculty').all();

  // Batches
  const batchesRaw = db.prepare('SELECT id, name, dept, semester, section, student_count as studentCount, default_room as defaultRoom FROM batches').all();

  // Courses
  const coursesRaw = db.prepare(`
    SELECT id, batch_id as batchId, code, title, faculty_id as facultyId,
           periods_per_week as periodsPerWeek, is_lab as isLab, duration,
           room_type as roomType, preferred_room as preferredRoom, color
    FROM courses
  `).all().map(c => ({ ...c, isLab: Boolean(c.isLab) }));

  // Timetable
  const timetableRaw = db.prepare(`
    SELECT id, batch_id as batchId, course_id as courseId, faculty_id as facultyId,
           room_id as roomId, day, period_id as periodId, is_lab as isLab, duration
    FROM timetable_entries
  `).all().map(t => ({ ...t, isLab: Boolean(t.isLab) }));

  return {
    institution,
    settings: settings || {
      days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      periods: [
        { id: 1, label: "Period 1", startTime: "09:00", endTime: "09:55", isBreak: false },
        { id: 2, label: "Period 2", startTime: "09:55", endTime: "10:50", isBreak: false },
        { id: 3, label: "Period 3", startTime: "11:05", endTime: "12:00", isBreak: false },
        { id: 4, label: "Lunch Break", startTime: "12:00", endTime: "01:00", isBreak: true },
        { id: 5, label: "Period 4", startTime: "01:00", endTime: "01:55", isBreak: false },
        { id: 6, label: "Period 5", startTime: "01:55", endTime: "02:50", isBreak: false },
        { id: 7, label: "Period 6", startTime: "02:55", endTime: "03:50", isBreak: false }
      ],
      maxDailyLecturesPerBatch: 5,
      maxConsecutiveLecturesPerTeacher: 3
    },
    departments,
    rooms,
    faculty: facultyRaw,
    batches: batchesRaw,
    courses: coursesRaw,
    timetable: timetableRaw
  };
}

function getDatabaseDiagnostics() {
  const getCount = (table) => {
    try {
      return db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
    } catch {
      return 0;
    }
  };

  const stat = fs.statSync(DB_PATH);

  return {
    engine: "SQLite 3 (Built-in node:sqlite)",
    databaseFile: "timetable.db",
    fileSizeBytes: stat.size,
    tables: {
      departments: getCount("departments"),
      rooms: getCount("rooms"),
      faculty: getCount("faculty"),
      batches: getCount("batches"),
      courses: getCount("courses"),
      timetable_entries: getCount("timetable_entries")
    }
  };
}

seedDatabaseIfEmpty();

// ============================================================================
// 3. HTTP Server & Hybrid REST API Endpoints
// ============================================================================

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Enable CORS for hybrid cross-origin development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- REST API Endpoints ---
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');

    try {
      // 1. Health & Database Status
      if (pathname === '/api/status' && req.method === 'GET') {
        const diagnostics = getDatabaseDiagnostics();
        res.writeHead(200);
        res.end(JSON.stringify({ status: "online", hybrid: true, diagnostics }));
        return;
      }

      // 2. Get Full Dataset
      if (pathname === '/api/data' && req.method === 'GET') {
        const dataset = getFullDatasetFromSQLite();
        res.writeHead(200);
        res.end(JSON.stringify(dataset));
        return;
      }

      // 3. Sync Full Dataset
      if (pathname === '/api/sync' && req.method === 'POST') {
        const payload = await readBody(req);
        saveFullDatasetToSQLite(payload);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: "Synchronized with SQLite database." }));
        return;
      }

      // 4. Save Timetable Allocation Only
      if (pathname === '/api/timetable' && req.method === 'POST') {
        const payload = await readBody(req);
        const entries = Array.isArray(payload) ? payload : (payload.entries || []);

        db.exec('BEGIN TRANSACTION;');
        db.exec('DELETE FROM timetable_entries;');
        const insertTT = db.prepare(`
          INSERT INTO timetable_entries(id, batch_id, course_id, faculty_id, room_id, day, period_id, is_lab, duration)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const t of entries) {
          insertTT.run(
            t.id, t.batchId, t.courseId, t.facultyId || null, t.roomId,
            t.day, t.periodId, t.isLab ? 1 : 0, t.duration || 1
          );
        }
        db.exec('COMMIT;');

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, count: entries.length }));
        return;
      }

      // 5. Reset to Sample University Dataset
      if (pathname === '/api/reset' && req.method === 'POST') {
        const sample = loadSampleDataFromDisk();
        saveFullDatasetToSQLite(sample);

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: "Database reset to sample state." }));
        return;
      }

      // 6. SQL Dump Export Endpoint
      if (pathname === '/api/export-sql' && req.method === 'GET') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="timetable_backup.sql"');

        let sqlDump = `-- UniSchedule SQLite Dump\n-- Generated: ${new Date().toISOString()}\n\n`;
        const tables = ['departments', 'rooms', 'faculty', 'batches', 'courses', 'timetable_entries', 'meta_settings'];
        for (const tbl of tables) {
          const rows = db.prepare(`SELECT * FROM ${tbl}`).all();
          sqlDump += `-- Table: ${tbl}\n`;
          for (const row of rows) {
            const keys = Object.keys(row);
            const vals = keys.map(k => {
              const val = row[k];
              if (val === null) return 'NULL';
              if (typeof val === 'number') return val;
              return `'${String(val).replace(/'/g, "''")}'`;
            });
            sqlDump += `INSERT INTO ${tbl} (${keys.join(', ')}) VALUES (${vals.join(', ')});\n`;
          }
          sqlDump += '\n';
        }
        res.writeHead(200);
        res.end(sqlDump);
        return;
      }

      // Unknown API endpoint
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Endpoint not found" }));
      return;
    } catch (err) {
      console.error("API Error:", err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  // --- Static File Serving ---
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  // Prevent directory traversal
  const safePath = path.normalize(path.join(PUBLIC_DIR, reqPath));
  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Access Denied');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(safePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`⚡ UniSchedule Hybrid Web Server Running!`);
  console.log(`🔗 Local URL:  http://localhost:${PORT}`);
  console.log(`💾 Database:   ${DB_PATH} (SQLite 3 via node:sqlite)`);
  console.log(`🚀 Mode:       Hybrid (REST API + SQLite + Offline-Capable)`);
  console.log(`=======================================================`);
});
