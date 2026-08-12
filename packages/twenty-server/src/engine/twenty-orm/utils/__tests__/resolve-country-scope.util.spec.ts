import {
  isCountryInScope,
  readMemberCountryScopeField,
  readRecordCountryCodeField,
  resolveCountryScope,
} from 'src/engine/twenty-orm/utils/resolve-country-scope.util';

describe('resolveCountryScope', () => {
  it('champ absent (undefined) => non cloisonné, pour ne rien casser sur un workspace upstream', () => {
    expect(resolveCountryScope(undefined)).toEqual({ kind: 'unscoped' });
  });

  it('« * » => non cloisonné (managers de zone large, ExCom, admins)', () => {
    expect(resolveCountryScope('*')).toEqual({ kind: 'unscoped' });
  });

  it('champ présent mais null => cloisonné avec une liste vide (default-deny)', () => {
    expect(resolveCountryScope(null)).toEqual({
      kind: 'countries',
      allowed: [],
    });
  });

  it('chaîne vide => cloisonné avec une liste vide (default-deny)', () => {
    expect(resolveCountryScope('')).toEqual({ kind: 'countries', allowed: [] });
  });

  it('découpe sur « ; », normalise la casse et ignore les vides', () => {
    expect(resolveCountryScope(' ci ; sn;; GB ')).toEqual({
      kind: 'countries',
      allowed: ['CI', 'SN', 'GB'],
    });
  });
});

describe('isCountryInScope', () => {
  const scope = resolveCountryScope('CI;SN');

  it('accepte un pays du périmètre, quelle que soit la casse', () => {
    expect(isCountryInScope(scope, 'ci')).toBe(true);
  });

  it('refuse un pays hors périmètre', () => {
    expect(isCountryInScope(scope, 'CO')).toBe(false);
  });

  it('refuse un countryCode absent, comme le fait `countryCode IN (...)` en SQL', () => {
    expect(isCountryInScope(scope, null)).toBe(false);
    expect(isCountryInScope(scope, undefined)).toBe(false);
  });

  it('accepte tout, countryCode absent compris, si le membre n’est pas cloisonné', () => {
    expect(isCountryInScope({ kind: 'unscoped' }, null)).toBe(true);
  });

  it('refuse tout si la liste est vide (membre sans pays)', () => {
    expect(isCountryInScope(resolveCountryScope(''), 'CI')).toBe(false);
  });
});

describe('lecture des champs custom', () => {
  it('lit allowedCountries sur un workspaceMember hydraté', () => {
    expect(
      readMemberCountryScopeField({ id: 'x', allowedCountries: 'CI;SN' }),
    ).toBe('CI;SN');
  });

  it('rend undefined quand le champ est absent (workspace non provisionné)', () => {
    expect(readMemberCountryScopeField({ id: 'x' })).toBeUndefined();
  });

  it('lit countryCode sur un enregistrement hydraté', () => {
    expect(readRecordCountryCodeField({ id: 'x', countryCode: 'CI' })).toBe(
      'CI',
    );
  });
});
