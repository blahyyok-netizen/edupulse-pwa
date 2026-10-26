-- Електронний журнал групи: перевірений склад студентів.
-- Список збирається з PDF рейтингу коледжу й підтверджується журнальним API
-- (200 лише для справжньої пари «група + прізвище + ім'я»).
CREATE TABLE IF NOT EXISTS group_students (
  group_code TEXT NOT NULL,
  student_id INTEGER NOT NULL,
  last_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  found_at INTEGER NOT NULL,
  PRIMARY KEY (group_code, student_id)
);

CREATE INDEX IF NOT EXISTS idx_group_students_code ON group_students (group_code);

-- Портал групи (об'явлення, самозапис, адмін) видалено.
DROP TABLE IF EXISTS announcements;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS groups;
