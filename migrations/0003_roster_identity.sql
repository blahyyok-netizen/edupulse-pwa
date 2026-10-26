-- Ідентифікація студента в групі — за прізвищем і ім'ям, а не за student_id.
-- student_id з журнального API є лише для підтверджених журналом студентів;
-- для складу, зібраного з наказів про зарахування, його ще немає. Тож ключ
-- має бути стабільним і без нього, а ще й не дублювати одну людину в групі.
CREATE TABLE IF NOT EXISTS group_students_v2 (
  group_code TEXT NOT NULL,
  student_id INTEGER,
  last_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'журнал',
  found_at INTEGER NOT NULL,
  PRIMARY KEY (group_code, last_name, first_name)
);

INSERT OR REPLACE INTO group_students_v2
  (group_code, student_id, last_name, first_name, source, found_at)
SELECT group_code, student_id, last_name, first_name, 'журнал', found_at FROM group_students;

DROP TABLE group_students;
ALTER TABLE group_students_v2 RENAME TO group_students;

CREATE INDEX IF NOT EXISTS idx_group_students_code ON group_students (group_code);
