-- 059: tell the Records Officer when an applicant sends a document.
--
-- An applicant replacing a document the office sent back, or adding one it
-- asked for, told nobody: the new file sat "Uploaded" until an officer
-- happened to open the application (found live, 2026-09-27). A type of its
-- own rather than reusing application-awaiting-you, because the unread-once
-- index is per type: an officer already holding an unread "is waiting" for
-- this application would otherwise never hear about the new document.

insert into staff_notification_types (type, requires_act) values
  ('document-resubmitted', true);
