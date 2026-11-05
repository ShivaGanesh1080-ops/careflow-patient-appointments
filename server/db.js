const sqlite3 = require('sqlite3').verbose();
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'careflow.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new sqlite3.Database(dbPath);
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function(error) { error ? reject(error) : resolve({id: this.lastID, changes: this.changes}); }));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (e, row) => e ? reject(e) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows)));
function localDate(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function localNow() { const d=new Date();return `${localDate(d)}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`; }
async function init() {
  await run('PRAGMA foreign_keys = ON');
  await run('PRAGMA journal_mode = WAL');
  await run('PRAGMA busy_timeout = 5000');
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, phone TEXT DEFAULT '', role TEXT NOT NULL CHECK(role IN ('patient','admin')) DEFAULT 'patient', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS doctors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, specialization TEXT NOT NULL, qualification TEXT NOT NULL, bio TEXT DEFAULT '', experience INTEGER NOT NULL CHECK(experience>=0), fee REAL NOT NULL CHECK(fee>=0), active INTEGER NOT NULL DEFAULT 1)`);
  await run(`CREATE TABLE IF NOT EXISTS slots (id INTEGER PRIMARY KEY, doctor_id INTEGER NOT NULL REFERENCES doctors(id), start_time TEXT NOT NULL, end_time TEXT NOT NULL, UNIQUE(doctor_id,start_time), CHECK(end_time>start_time))`);
  await run(`CREATE TABLE IF NOT EXISTS appointments (id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES users(id), doctor_id INTEGER NOT NULL REFERENCES doctors(id), slot_id INTEGER NOT NULL REFERENCES slots(id), reason TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'booked' CHECK(status IN ('booked','cancelled','completed')), created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  const columns=await all('PRAGMA table_info(appointments)');
  if(!columns.some(c=>c.name==='cancellation_reason'))await run("ALTER TABLE appointments ADD COLUMN cancellation_reason TEXT DEFAULT ''");
  if(!columns.some(c=>c.name==='cancelled_by'))await run("ALTER TABLE appointments ADD COLUMN cancelled_by TEXT DEFAULT ''");
  await run(`CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),appointment_id INTEGER REFERENCES appointments(id),title TEXT NOT NULL,message TEXT NOT NULL,reason TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP,read_at TEXT,email_status TEXT NOT NULL DEFAULT 'pending')`);
  await run(`CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,id)`);
  await run(`CREATE TABLE IF NOT EXISTS email_jobs(id INTEGER PRIMARY KEY,notification_id INTEGER UNIQUE NOT NULL REFERENCES notifications(id),recipient TEXT NOT NULL,attempts INTEGER DEFAULT 0,next_attempt_at TEXT DEFAULT CURRENT_TIMESTAMP,last_error TEXT DEFAULT '',sent_at TEXT)`);
  // Trigger keeps cancellation, durable notification, and outbox insert atomic.
  await run(`CREATE TRIGGER IF NOT EXISTS clinic_cancellation_notice AFTER UPDATE OF status ON appointments WHEN NEW.status='cancelled' AND OLD.status='booked' AND NEW.cancelled_by='admin' BEGIN
    INSERT INTO notifications(user_id,appointment_id,title,message,reason)
      SELECT NEW.patient_id,NEW.id,'Appointment cancelled by clinic','The clinic cancelled your appointment with ' || d.name || ' on ' || s.start_time || '. Reason: ' || NEW.cancellation_reason,NEW.cancellation_reason
      FROM doctors d JOIN slots s ON s.doctor_id=d.id WHERE s.id=NEW.slot_id;
    INSERT INTO email_jobs(notification_id,recipient) SELECT last_insert_rowid(),email FROM users WHERE id=NEW.patient_id;
  END`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_slot ON appointments(slot_id) WHERE status IN ('booked','completed')`);
  await run(`CREATE INDEX IF NOT EXISTS appointment_patient ON appointments(patient_id)`);
  for (const [name,email,password,role] of [['Demo Patient','patient@careflow.demo','Patient123!','patient'],['Clinic Administrator','admin@careflow.demo','Admin123!','admin']]) {
    await run('INSERT OR IGNORE INTO users(name,email,password_hash,role,phone) VALUES(?,?,?,?,?)',[name,email,await bcrypt.hash(password,10),role,'']);
  }
  if (!(await get('SELECT id FROM doctors LIMIT 1'))) {
    const doctors=[
      ['Dr. Ananya Rao','General Medicine','MBBS, MD','Thoughtful primary care, preventive checkups, and support for everyday health concerns.',12,500],
      ['Dr. Arjun Mehta','Cardiology','MBBS, MD, DM','Heart health consultations with a focus on prevention and long-term wellbeing.',16,900],
      ['Dr. Priya Nair','Dermatology','MBBS, MD','Personalized care for skin, hair, and common dermatological conditions.',9,650],
      ['Dr. Rohan Shah','Orthopedics','MBBS, MS','Helping you move comfortably through bone, joint, and sports injury care.',14,800],
      ['Dr. Kavya Reddy','Pediatrics','MBBS, MD','Friendly, family-centered consultations for children and adolescents.',11,600],
      ['Dr. Sameer Iyer','Neurology','MBBS, MD, DM','Consultations for headaches, nerve conditions, and neurological wellbeing.',15,1000]
    ];
    for(const d of doctors) await run('INSERT INTO doctors(name,specialization,qualification,bio,experience,fee) VALUES(?,?,?,?,?,?)',d);
  }
  // Populate a rolling two-week demo calendar without overwriting existing data.
  for (const doctor of await all('SELECT id FROM doctors WHERE active=1')) {
    for(let day=1;day<=14;day++) {
      const date=new Date();date.setDate(date.getDate()+day);if(date.getDay()===0)continue;
      const stamp=localDate(date);
      for(const hour of [9,10,11,14,15]) for(const minute of [0,30]) {
        const start=`${stamp}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00`;
        const end=`${stamp}T${String(minute===30?hour+1:hour).padStart(2,'0')}:${minute===30?'00':'30'}:00`;
        await run('INSERT OR IGNORE INTO slots(doctor_id,start_time,end_time) VALUES(?,?,?)',[doctor.id,start,end]);
      }
    }
  }
}
module.exports={db,run,get,all,init,localDate,localNow};
