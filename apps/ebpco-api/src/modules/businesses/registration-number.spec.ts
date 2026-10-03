import { registrationDateProblem, registrationNumberProblem } from './registration-number';

/** QA finding TC-24 (2026-10-03): "x" was accepted as a DTI / SEC / CDA registration number. */
describe('registrationNumberProblem', () => {
  it.each(['1234567', 'CS201912345', 'A199912345', '9520-05012345', 'BN 3456789'])('accepts %s', (number) => {
    expect(registrationNumberProblem(number)).toBeNull();
  });

  it.each([
    ['x', /5 to 40 characters/],
    ['ABCDE', /at least 4 digits/],
    ['DTI#12345', /only letters, numbers/],
  ])('refuses %s', (number, why) => {
    expect(registrationNumberProblem(number)).toMatch(why);
  });
});

describe('registrationDateProblem', () => {
  const today = new Date('2026-10-03T08:00:00Z');

  it('accepts a past day and today', () => {
    expect(registrationDateProblem('2026-03-15', today)).toBeNull();
    expect(registrationDateProblem('2026-10-03', today)).toBeNull();
  });

  it('refuses a future day and a day that does not exist', () => {
    expect(registrationDateProblem('2026-10-04', today)).toMatch(/future/);
    expect(registrationDateProblem('2026-02-30', today)).toMatch(/as it appears/);
  });
});
