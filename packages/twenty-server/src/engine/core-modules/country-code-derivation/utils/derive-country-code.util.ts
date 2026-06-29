import { isDefined } from 'twenty-shared/utils';

// Dérivation automatique du champ dénormalisé `countryCode` (cloisonnement par
// pays, cf. apply-country-permission-filter.util.ts). Sans `countryCode`, un
// enregistrement est invisible (default-deny) pour un utilisateur scoppé — y
// compris son créateur. Ce champ ne doit JAMAIS être saisi à la main : il est
// dérivé de la relation `country` (par l'agent d'ingestion hier, par ce hook
// serveur aujourd'hui, pour les écritures UI comme API).

export const COUNTRY_CODE_FIELD = 'countryCode';

export type CountryCodeRecord = Record<string, unknown>;

// Comment dériver `countryCode` selon l'objet cloisonné :
// - `self`   : l'objet porte lui-même la relation pays (`countryId` -> country.isoCode).
// - `parent` : l'objet hérite du `countryCode` de sa company parente via une FK.
type CountryCodeDerivation =
  | { kind: 'self'; fkField: 'countryId' }
  | { kind: 'parent'; fkField: 'companyId' | 'clientId' };

export const COUNTRY_CODE_DERIVATION_BY_OBJECT: Record<
  string,
  CountryCodeDerivation
> = {
  company: { kind: 'self', fkField: 'countryId' },
  person: { kind: 'parent', fkField: 'companyId' },
  opportunity: { kind: 'parent', fkField: 'companyId' },
  clientProduct: { kind: 'parent', fkField: 'clientId' },
  visit: { kind: 'parent', fkField: 'clientId' },
};

export const getCountryCodeDerivation = (
  objectMetadataNameSingular: string,
): CountryCodeDerivation | undefined =>
  COUNTRY_CODE_DERIVATION_BY_OBJECT[objectMetadataNameSingular];

// Identifiants de FK (countryId | companyId | clientId) présents dans le payload,
// à résoudre côté base pour obtenir le countryCode.
export const collectCountryCodeFkIds = (
  objectMetadataNameSingular: string,
  records: CountryCodeRecord[],
): string[] => {
  const derivation = getCountryCodeDerivation(objectMetadataNameSingular);

  if (!isDefined(derivation)) {
    return [];
  }

  const ids = new Set<string>();

  for (const record of records) {
    const fkId = record[derivation.fkField];

    if (typeof fkId === 'string' && fkId.length > 0) {
      ids.add(fkId);
    }
  }

  return [...ids];
};

// Pose `countryCode` sur chaque record dont la FK est résolue. N'écrit jamais
// si la FK est absente du payload (update partiel) ou non résolue : on ne doit
// pas effacer un countryCode existant ni en inventer un.
export const applyCountryCodeToRecords = (
  objectMetadataNameSingular: string,
  records: CountryCodeRecord[],
  countryCodeByFkId: Map<string, string | null>,
): CountryCodeRecord[] => {
  const derivation = getCountryCodeDerivation(objectMetadataNameSingular);

  if (!isDefined(derivation)) {
    return records;
  }

  return records.map((record) => {
    const fkId = record[derivation.fkField];

    if (typeof fkId !== 'string') {
      return record;
    }

    const derivedCountryCode = countryCodeByFkId.get(fkId);

    if (!isDefined(derivedCountryCode)) {
      return record;
    }

    return { ...record, [COUNTRY_CODE_FIELD]: derivedCountryCode };
  });
};
