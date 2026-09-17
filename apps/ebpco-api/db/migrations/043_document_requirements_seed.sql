-- 043_document_requirements_seed.sql
--
-- `document_requirements` (022) has existed since the table was created and
-- has NEVER once had a row in it, in any environment: not the fresh Linode
-- deployment, and the migration history shows no earlier seed either. Every
-- application ever filed therefore snapshots `required_documents = '[]'`
-- (`submission.service.ts`'s `RequirementsService.forPermitType()` correctly
-- queries this table -- there is simply nothing in it to return), which makes
-- `evaluation.service.ts`'s `requiredDocumentCount` zero for every
-- application regardless of permit type. The Evaluations queue's "Missing
-- Documents" column (`requiredDocumentCount - attachedDocumentCount`) then
-- goes NEGATIVE the moment an applicant attaches anything at all -- reported
-- live as "-6" on an application that had all six of its real, required
-- documents correctly attached.
--
-- The content below is transcribed from the citizen portal's own
-- `core/domain/requirements-catalog.ts` (`REQUIREMENTS_CATALOG`, the Admin
-- Portal's copy is byte-identical per that file's own doc comment), taking
-- only the narrower shape this table asks for -- `code`/`label`/`description`/
-- `required`/`position` -- and deliberately leaving out the wider portal
-- bundle (reviewing office, evaluation sequence, validity rules), exactly as
-- 022's own doc comment says this table should. 'Business Permit' is not in
-- that 19-entry catalog (it uses the separate, generic 3-item
-- `GENERIC_APPLICATION_DOCUMENTS` list instead) and is seeded from that here,
-- completing all twenty rows of `permit_types`.

begin;

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Building Permit – New Construction', 'bpnc-oct-tct', 'Certified True Copy of OCT/TCT', 'Or Deed of Sale, Deed of Donation, Lease Contract, or Assignment of Rights if not the registered owner.', true, 0),
  ('Building Permit – New Construction', 'bpnc-survey-plan', 'Survey Plan', '', true, 1),
  ('Building Permit – New Construction', 'bpnc-design-plans', 'Design Plans (duly signed and sealed)', 'Architectural, Civil/Structural, Electrical, Sanitary/Plumbing, and Mechanical as applicable.', true, 2),
  ('Building Permit – New Construction', 'bpnc-unified-form', 'Unified Building Permit Form', '', true, 3),
  ('Building Permit – New Construction', 'bpnc-ancillary-electrical', 'Electrical Permit (ancillary application form)', 'If the project scope includes electrical work.', false, 4),
  ('Building Permit – New Construction', 'bpnc-ancillary-fencing', 'Fencing Permit (ancillary application form)', 'If the project scope includes fencing.', false, 5),
  ('Building Permit – New Construction', 'bpnc-ancillary-architectural', 'Architectural Permit (ancillary application form)', '', false, 6),
  ('Building Permit – New Construction', 'bpnc-ancillary-sanitary-plumbing', 'Sanitary/Plumbing Permit (ancillary application form)', 'If the project scope includes sanitary/plumbing work.', false, 7),
  ('Building Permit – New Construction', 'bpnc-ancillary-mechanical', 'Mechanical Permit (ancillary application form)', 'If the project scope includes mechanical work.', false, 8),
  ('Building Permit – New Construction', 'bpnc-ancillary-civil-structural', 'Civil/Structural Permit (ancillary application form)', '', false, 9),
  ('Building Permit – New Construction', 'bpnc-ancillary-excavation', 'Excavation Permit (ancillary application form)', 'If the project scope includes excavation.', false, 10),
  ('Building Permit – New Construction', 'bpnc-ancillary-electronics', 'Electronics Permit (ancillary application form)', 'If the project scope includes electronics/communications installation.', false, 11),
  ('Building Permit – New Construction', 'bpnc-cost-estimate', 'Cost Estimate (duly signed and sealed)', '', true, 12),
  ('Building Permit – New Construction', 'bpnc-technical-specs', 'Technical Specifications (duly signed and sealed)', '', true, 13),
  ('Building Permit – New Construction', 'bpnc-structural-design-analysis', 'Structural Design and Analysis', '', true, 14),
  ('Building Permit – New Construction', 'bpnc-soil-analysis', 'Soil Analysis / Plate Load Test / Seismic Analysis', '', true, 15),
  ('Building Permit – New Construction', 'bpnc-professional-licenses', 'Valid Licenses (PRC) of all involved professionals', '', true, 16),
  ('Building Permit – New Construction', 'bpnc-valid-id', 'Valid ID of Applicant and Owner of Lot', '', true, 17),
  ('Building Permit – New Construction', 'bpnc-zoning-locational', 'Zoning / Locational Clearance', 'Issued by MPDC.', true, 18),
  ('Building Permit – New Construction', 'bpnc-fire-safety-clearance', 'Fire Safety Evaluation Clearance', 'Issued by BFP.', true, 19),
  ('Building Permit – New Construction', 'bpnc-construction-safety-health', 'Approved Construction Safety and Health Program', 'Issued by DOLE.', true, 20),
  ('Building Permit – New Construction', 'bpnc-road-clearance', 'Road Clearance', 'Issued by DPWH/PEO.', true, 21);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Building Permit – Renovation / Alteration', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Building Permit – Renovation / Alteration', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Building Permit – Renovation / Alteration', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Building Permit – Renovation / Alteration', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Building Permit – Renovation / Alteration', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Building Permit – Renovation / Alteration', 'renovation-plan', 'Renovation/Alteration Plans (signed and sealed)', '', true, 5),
  ('Building Permit – Renovation / Alteration', 'renovation-existing-permit', 'Copy of Original Building Permit (if available)', '', false, 6),
  ('Building Permit – Renovation / Alteration', 'renovation-bom', 'Bill of Materials and Specifications', '', true, 7),
  ('Building Permit – Renovation / Alteration', 'renovation-prc', 'PRC License and PTR of Engineer/Architect of Record', '', true, 8);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Building Permit – Addition / Extension', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Building Permit – Addition / Extension', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Building Permit – Addition / Extension', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Building Permit – Addition / Extension', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Building Permit – Addition / Extension', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Building Permit – Addition / Extension', 'addition-plan', 'Addition / Extension Plans (signed and sealed)', '', true, 5),
  ('Building Permit – Addition / Extension', 'addition-struct-plan', 'Structural Analysis for the added load (signed and sealed)', '', true, 6),
  ('Building Permit – Addition / Extension', 'addition-bom', 'Bill of Materials and Specifications', '', true, 7),
  ('Building Permit – Addition / Extension', 'addition-prc', 'PRC License and PTR of Engineer/Architect of Record', '', true, 8);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Demolition Permit', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Demolition Permit', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Demolition Permit', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Demolition Permit', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Demolition Permit', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Demolition Permit', 'demolition-method', 'Method of Demolition / Work Plan', '', true, 5),
  ('Demolition Permit', 'demolition-safety', 'Structural Safety Assessment and Safety Measures Plan', '', true, 6),
  ('Demolition Permit', 'demolition-prc', 'PRC License and PTR of Engineer of Record', '', true, 7),
  ('Demolition Permit', 'demolition-utility-clearance', 'Utility Disconnection Clearance (water/power)', '', false, 8);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Zoning / Locational Clearance', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Zoning / Locational Clearance', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Zoning / Locational Clearance', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Zoning / Locational Clearance', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 3),
  ('Zoning / Locational Clearance', 'zoning-letter-request', 'Notarized Letter Request addressed to the Zoning Administrator', '', true, 4),
  ('Zoning / Locational Clearance', 'zoning-site-plan', 'Site Development Plan', '', true, 5),
  ('Zoning / Locational Clearance', 'zoning-vicinity-map', 'Vicinity Map', '', true, 6),
  ('Zoning / Locational Clearance', 'zoning-sketch-plan', 'Sketch Plan of the House', '', true, 7),
  ('Zoning / Locational Clearance', 'zoning-bom', 'Bill of Materials', '', true, 8),
  ('Zoning / Locational Clearance', 'zoning-ownership', 'Proof of Ownership', '', true, 9),
  ('Zoning / Locational Clearance', 'zoning-tax-dec', 'Tax Declaration / Certificate of Title (COT) / OCT', '', true, 10),
  ('Zoning / Locational Clearance', 'zoning-land-tax', 'Land Tax Receipt (Current Year)', '', true, 11),
  ('Zoning / Locational Clearance', 'zoning-brgy-building-clearance', 'Barangay Building Clearance', '', true, 12),
  ('Zoning / Locational Clearance', 'zoning-cedula', 'Cedula (Photocopy)', '', true, 13),
  ('Zoning / Locational Clearance', 'zoning-dpwh', 'DPWH Clearance (if applicable)', '', false, 14),
  ('Zoning / Locational Clearance', 'zoning-ecc', 'Environmental Compliance Certificate / ECC (if applicable)', '', false, 15);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Architectural Permit', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Architectural Permit', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Architectural Permit', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Architectural Permit', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Architectural Permit', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Architectural Permit', 'arch-plan', 'Architectural Plans (signed and sealed)', '', true, 5),
  ('Architectural Permit', 'arch-prc', 'PRC License and PTR of Architect of Record', '', true, 6);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Civil / Structural Permit', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Civil / Structural Permit', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Civil / Structural Permit', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Civil / Structural Permit', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Civil / Structural Permit', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Civil / Structural Permit', 'struct-plan', 'Structural Plans (signed and sealed)', '', true, 5),
  ('Civil / Structural Permit', 'struct-analysis', 'Structural Design Analysis', '', true, 6),
  ('Civil / Structural Permit', 'struct-prc', 'PRC License and PTR of Civil Engineer of Record', '', true, 7);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Electrical Permit', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Electrical Permit', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Electrical Permit', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Electrical Permit', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Electrical Permit', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Electrical Permit', 'elec-plan', 'Electrical Plans (signed and sealed)', '', true, 5),
  ('Electrical Permit', 'elec-prc', 'PRC License and PTR of Professional Electrical Engineer of Record', '', true, 6);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Mechanical Permit', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Mechanical Permit', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Mechanical Permit', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Mechanical Permit', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Mechanical Permit', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Mechanical Permit', 'mech-plan', 'Mechanical Plans (signed and sealed)', '', true, 5),
  ('Mechanical Permit', 'mech-prc', 'PRC License and PTR of Professional Mechanical Engineer of Record', '', true, 6);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Sanitary Permit', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Sanitary Permit', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Sanitary Permit', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Sanitary Permit', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Sanitary Permit', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Sanitary Permit', 'sanplumb-plan', 'Sanitary / Plumbing Plans (signed and sealed)', '', true, 5),
  ('Sanitary Permit', 'sanplumb-prc', 'PRC License and PTR of Sanitary Engineer/Master Plumber of Record', '', true, 6);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Plumbing Permit', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Plumbing Permit', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Plumbing Permit', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Plumbing Permit', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Plumbing Permit', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Plumbing Permit', 'plumb-plan', 'Plumbing Layout Plans (signed and sealed)', '', true, 5),
  ('Plumbing Permit', 'plumb-prc', 'PRC License and PTR of Master Plumber of Record', '', true, 6);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Electronics Permit', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Electronics Permit', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Electronics Permit', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Electronics Permit', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Electronics Permit', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Electronics Permit', 'electronics-plan', 'Electronics/Communications Layout Plans (signed and sealed)', '', true, 5),
  ('Electronics Permit', 'electronics-prc', 'PRC License and PTR of Professional Electronics Engineer of Record', '', true, 6);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Interior Design Permit', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Interior Design Permit', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Interior Design Permit', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Interior Design Permit', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Interior Design Permit', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Interior Design Permit', 'interior-plan', 'Interior Design Layout Plans (signed and sealed)', '', true, 5),
  ('Interior Design Permit', 'interior-prc', 'PRC License and PTR of Interior Designer of Record', '', true, 6);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Fencing Permit', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Fencing Permit', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Fencing Permit', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Fencing Permit', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Fencing Permit', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Fencing Permit', 'fencing-plan', 'Fence Plan / Site Development Plan', '', true, 5);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Sign Permit', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Sign Permit', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Sign Permit', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Sign Permit', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Sign Permit', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Sign Permit', 'sign-plan', 'Sign Design and Structural Detail (if elevated or free-standing)', '', true, 5),
  ('Sign Permit', 'sign-prc', 'PRC License and PTR of Engineer of Record (required for elevated/structural signs)', '', false, 6);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Excavation Permit', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Excavation Permit', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Excavation Permit', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Excavation Permit', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Excavation Permit', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Excavation Permit', 'excavation-plan', 'Excavation/Site Development Plan', '', true, 5),
  ('Excavation Permit', 'excavation-geotech', 'Geotechnical/Soil Assessment (if excavation exceeds regulated depth)', '', false, 6),
  ('Excavation Permit', 'excavation-prc', 'PRC License and PTR of Engineer of Record', '', true, 7);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('FSEC for Building Permit (BFP)', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('FSEC for Building Permit (BFP)', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('FSEC for Building Permit (BFP)', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('FSEC for Building Permit (BFP)', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('FSEC for Building Permit (BFP)', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('FSEC for Building Permit (BFP)', 'fsec-plan-set', 'Three (3) complete sets of proposed plans: Architectural, Civil/Structural, Electrical, Mechanical, Plumbing, Electronics, Sanitary, and Fire Protection documents', '', true, 5),
  ('FSEC for Building Permit (BFP)', 'fsec-fscr', 'Fire Safety Compliance Report (FSCR), one (1) set (if necessary)', '', false, 6),
  ('FSEC for Building Permit (BFP)', 'fsec-cost-estimate', 'Cost Estimate of the building, including labor cost, signed, sealed, and notarized, one (1) set', '', true, 7),
  ('FSEC for Building Permit (BFP)', 'fsec-hotworks-clearance', 'Fire Safety Clearance for Welding, Cutting, and other Hot Work Operations (if required)', '', false, 8);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Certificate of Occupancy', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('Certificate of Occupancy', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('Certificate of Occupancy', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('Certificate of Occupancy', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('Certificate of Occupancy', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('Certificate of Occupancy', 'coo-asbuilt', 'As-Built Plans', '', true, 5),
  ('Certificate of Occupancy', 'coo-completion', 'Certificate of Completion', '', true, 6),
  ('Certificate of Occupancy', 'coo-fsic', 'Fire Safety Inspection Certificate (final)', '', true, 7),
  ('Certificate of Occupancy', 'coo-electrical-final', 'Certificate of Final Electrical Inspection', '', true, 8);

insert into document_requirements (permit_type, code, label, description, required, position) values
  ('FSIC for Occupancy Permit (BFP)', 'land-title', 'Land Title or Tax Declaration of the property', '', true, 0),
  ('FSIC for Occupancy Permit (BFP)', 'owner-consent', 'Owner''s Written Consent (if applicant is not the lot owner)', '', false, 1),
  ('FSIC for Occupancy Permit (BFP)', 'brgy-clearance', 'Barangay Clearance', '', true, 2),
  ('FSIC for Occupancy Permit (BFP)', 'locational', 'Locational Clearance / Zoning Certification', '', true, 3),
  ('FSIC for Occupancy Permit (BFP)', 'valid-id', 'Valid Government-Issued ID of Applicant/Owner', '', true, 4),
  ('FSIC for Occupancy Permit (BFP)', 'fsic-asbuilt', 'As-Built Plan (if necessary)', '', false, 5),
  ('FSIC for Occupancy Permit (BFP)', 'fsic-obo-endorsement', 'Endorsement from the Office of the Building Official (OBO)', '', true, 6),
  ('FSIC for Occupancy Permit (BFP)', 'fsic-completion-cert', 'Certificate of Completion', '', true, 7),
  ('FSIC for Occupancy Permit (BFP)', 'fsic-assessment-copy', 'Certified True Copy of the Assessment Fee for securing the Certificate of Occupancy from OBO', '', true, 8),
  ('FSIC for Occupancy Permit (BFP)', 'fsic-fsccr', 'Fire Safety Compliance and Commissioning Report (FSCCR), one (1) set (if necessary)', '', false, 9);

-- 'Business Permit' is not in the 19-entry catalog above -- it uses the
-- citizen portal's separate, generic 3-item list (`GENERIC_APPLICATION_
-- DOCUMENTS`), which is what the New Application wizard actually asks for.
insert into document_requirements (permit_type, code, label, description, required, position) values
  ('Business Permit', 'generic-valid-id', 'Valid Government ID', '', true, 0),
  ('Business Permit', 'generic-brgy-clearance', 'Barangay Clearance', '', true, 1),
  ('Business Permit', 'generic-proof-address', 'Proof of Business Address', '', true, 2);

-- Every application filed while the table above was empty snapshotted
-- `required_documents = '[]'` at filing time (022's own by-design behaviour:
-- the snapshot is taken once, at submission, and is never re-read from the
-- catalogue afterwards). That snapshot was never a policy decision about
-- what any of these applications were asked for -- it is a seeding bug, filed
-- against a catalogue that had nothing in it yet. Backfilling it now is the
-- same kind of one-time correction as re-running the three stuck lifecycle
-- transitions on the application the onsite-payment bug had left behind
-- (see the `staff-actions.controller.ts` `recordOnsite` fix): repairing a
-- fact this deployment recorded wrong, not overriding one it recorded on
-- purpose.
update applications a
   set required_documents = (
     select coalesce(
              jsonb_agg(
                jsonb_build_object(
                  'code', dr.code, 'label', dr.label,
                  'description', dr.description, 'required', dr.required
                )
                order by dr.position, dr.code
              ),
              '[]'::jsonb
            )
       from document_requirements dr
      where dr.permit_type = a.permit_type
   )
 where coalesce(jsonb_array_length(a.required_documents), 0) = 0;

commit;
