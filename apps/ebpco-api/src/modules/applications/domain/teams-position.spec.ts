import { positionOf } from './teams';
import { checklistOf } from '../application/staff-queue.service';

/** QA finding TC-02 (2026-10-03): logs and timelines said "staff", never who. */
describe('positionOf', () => {
  it('names the capacity someone acted in', () => {
    expect(positionOf('applicant', [], [])).toBe('Applicant');
    expect(positionOf('staff', ['super-admin'], [])).toBe('Super Admin');
    expect(positionOf('staff', ['cashier'], [])).toBe('Cashier');
    expect(positionOf('staff', ['evaluator'], ['Initial', 'Zoning'])).toBe('Initial Evaluator, Zoning Officer');
  });

  it('is null for a system act or a staff account with no team', () => {
    expect(positionOf(null, [], [])).toBeNull();
    expect(positionOf('staff', [], [])).toBeNull();
  });
});

/** QA finding TC-01 (2026-10-03): the portal guessed each document's stage, and guessed wrong. */
describe('checklistOf', () => {
  it('reads the snapshot with each document\'s stage', () => {
    expect(checklistOf([
      { code: 'bpnc-oct-tct', label: 'Certified True Copy of OCT/TCT', required: true, stage: 'Initial' },
      { code: 'old-entry', label: 'Old', required: false },
      'nonsense',
      { label: 'no code' },
    ])).toEqual([
      { code: 'bpnc-oct-tct', label: 'Certified True Copy of OCT/TCT', required: true, stage: 'Initial' },
      { code: 'old-entry', label: 'Old', required: false, stage: null },
    ]);
  });

  it('is empty for no snapshot', () => {
    expect(checklistOf(null)).toEqual([]);
  });
});
