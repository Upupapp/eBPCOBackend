-- Which permit a Renewal or an Amendment is about.
--
-- `application_action` has always carried 'New', 'Renewal' and 'Amendment',
-- and nothing anywhere said WHAT was being renewed. An officer opening a
-- renewal saw the word and had to find the original by searching the
-- applicant's name — and two applicants with similar names is how the wrong
-- permit gets renewed.
--
-- A foreign key to the permit, not a copy of its number. A number typed into a
-- text column is a claim; a key is a link that cannot point at a permit the LGU
-- never issued, and it survives the number's format changing.
alter table applications
  add column renews_permit_id uuid references generated_permits (application_id) on delete restrict;

-- A New application renews nothing, and a Renewal that renews nothing is the
-- defect this column exists to prevent. Enforced here as well as in the service
-- because it is a property of the row, and a row that violates it is wrong
-- however it got written.
alter table applications add constraint renewal_names_what_it_renews check (
  (application_action = 'New' and renews_permit_id is null)
  or (application_action <> 'New' and renews_permit_id is not null)
);

create index applications_renews_idx on applications (renews_permit_id)
  where renews_permit_id is not null;
