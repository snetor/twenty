import {
  applyCountryCodeToRecords,
  collectCountryCodeFkIds,
  getCountryCodeDerivation,
} from 'src/engine/core-modules/country-code-derivation/utils/derive-country-code.util';

describe('derive-country-code.util', () => {
  describe('getCountryCodeDerivation', () => {
    it('mappe les 5 objets cloisonnés', () => {
      expect(getCountryCodeDerivation('company')).toEqual({
        kind: 'self',
        fkField: 'countryId',
      });
      expect(getCountryCodeDerivation('person')).toEqual({
        kind: 'parent',
        fkField: 'companyId',
      });
      expect(getCountryCodeDerivation('opportunity')).toEqual({
        kind: 'parent',
        fkField: 'companyId',
      });
      expect(getCountryCodeDerivation('clientProduct')).toEqual({
        kind: 'parent',
        fkField: 'clientId',
      });
      expect(getCountryCodeDerivation('visit')).toEqual({
        kind: 'parent',
        fkField: 'clientId',
      });
    });

    it('retourne undefined pour un objet non cloisonné', () => {
      expect(getCountryCodeDerivation('salesperson')).toBeUndefined();
      expect(getCountryCodeDerivation('note')).toBeUndefined();
    });
  });

  describe('collectCountryCodeFkIds', () => {
    it('collecte les countryId distincts pour company', () => {
      expect(
        collectCountryCodeFkIds('company', [
          { countryId: 'c1' },
          { countryId: 'c2' },
          { countryId: 'c1' },
        ]),
      ).toEqual(['c1', 'c2']);
    });

    it('collecte les companyId pour person, clientId pour visit', () => {
      expect(collectCountryCodeFkIds('person', [{ companyId: 'co1' }])).toEqual(
        ['co1'],
      );
      expect(collectCountryCodeFkIds('visit', [{ clientId: 'co9' }])).toEqual([
        'co9',
      ]);
    });

    it('ignore les records sans FK ou avec FK non-string', () => {
      expect(
        collectCountryCodeFkIds('company', [
          { name: 'sans pays' },
          { countryId: null },
          { countryId: '' },
        ]),
      ).toEqual([]);
    });

    it('retourne [] pour un objet non cloisonné', () => {
      expect(
        collectCountryCodeFkIds('salesperson', [{ countryId: 'c1' }]),
      ).toEqual([]);
    });
  });

  describe('applyCountryCodeToRecords', () => {
    it('pose countryCode dérivé quand la FK est résolue (company)', () => {
      const result = applyCountryCodeToRecords(
        'company',
        [{ name: 'Acme', countryId: 'c1' }],
        new Map([['c1', 'CO']]),
      );

      expect(result).toEqual([
        { name: 'Acme', countryId: 'c1', countryCode: 'CO' },
      ]);
    });

    it('hérite du countryCode de la company parente (person)', () => {
      const result = applyCountryCodeToRecords(
        'person',
        [{ companyId: 'co1' }],
        new Map([['co1', 'DE']]),
      );

      expect(result).toEqual([{ companyId: 'co1', countryCode: 'DE' }]);
    });

    it("n'écrit pas countryCode si la FK est absente du payload", () => {
      const result = applyCountryCodeToRecords(
        'company',
        [{ name: 'maj partielle' }],
        new Map([['c1', 'CO']]),
      );

      expect(result).toEqual([{ name: 'maj partielle' }]);
      expect(result[0]).not.toHaveProperty('countryCode');
    });

    it("n'écrit pas countryCode si la FK est non résolue ou sans pays", () => {
      const result = applyCountryCodeToRecords(
        'company',
        [{ countryId: 'inconnu' }, { countryId: 'sans-iso' }],
        new Map([['sans-iso', null]]),
      );

      expect(result[0]).not.toHaveProperty('countryCode');
      expect(result[1]).not.toHaveProperty('countryCode');
    });

    it('laisse les objets non cloisonnés intacts', () => {
      const records = [{ countryId: 'c1' }];
      const result = applyCountryCodeToRecords(
        'salesperson',
        records,
        new Map([['c1', 'CO']]),
      );

      expect(result).toBe(records);
    });
  });
});
