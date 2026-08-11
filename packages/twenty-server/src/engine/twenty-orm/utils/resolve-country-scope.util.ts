// Sémantique du périmètre pays d'un membre, extraite de
// `apply-country-permission-filter.util.ts` pour être partagée.
//
// Elle existe séparément parce que le cloisonnement par pays doit se décider à DEUX
// endroits, et qu'une divergence entre les deux est un trou de sécurité silencieux :
//
// 1. le choke-point ORM (`WorkspaceSelectQueryBuilder.validatePermissions`), qui filtre
//    toute requête d'objet d'un contexte utilisateur ;
// 2. les chemins qui s'exécutent délibérément sous `buildSystemAuthContext` et que l'ORM
//    laisse donc passer — aujourd'hui les resolvers de l'onglet Emails
//    (`get-messages.service.ts`), qui lisent la messagerie hors du périmètre de l'ORM
//    workspace.
//
// Toute nouvelle surface en contexte système doit appeler ces deux fonctions plutôt que
// de réimplémenter le découpage de `allowedCountries`.

export const ALL_COUNTRIES = '*';
export const MEMBER_SCOPE_FIELD = 'allowedCountries';
export const COUNTRY_FIELD = 'countryCode';

export type CountryScope =
  // Aucun cloisonnement : soit le champ `allowedCountries` est absent du workspaceMember
  // (workspace upstream ou de test, non provisionné par Snetor), soit il vaut `*`
  // (managers de zone large, ExCom, admins).
  | { kind: 'unscoped' }
  // Cloisonnement actif. `allowed` vide = default-deny : un membre Snetor sans pays ne
  // voit rien. C'est volontaire — deux beta testeurs et un administrateur ont ouvert un
  // workspace vide pendant six semaines pour cette raison, et un refus visible vaut mieux
  // qu'une fuite.
  | { kind: 'countries'; allowed: string[] };

/**
 * `raw` est la valeur brute du champ `allowedCountries` du workspaceMember courant.
 *
 * ⚠️ `undefined` et `null` ne veulent PAS dire la même chose :
 *  - `undefined` = champ absent de l'enregistrement → workspace non cloisonné → no-op ;
 *  - `null` ou `''` = champ présent mais vide → membre sans pays → default-deny.
 */
export const resolveCountryScope = (
  raw: string | null | undefined,
): CountryScope => {
  if (raw === undefined) {
    return { kind: 'unscoped' };
  }

  if (raw === ALL_COUNTRIES) {
    return { kind: 'unscoped' };
  }

  return {
    kind: 'countries',
    allowed: (raw ?? '')
      .split(';')
      .map((iso) => iso.trim().toUpperCase())
      .filter((iso) => iso.length > 0),
  };
};

// `allowedCountries` et `countryCode` sont des champs custom Snetor : ils sont hydratés sur
// l'enregistrement mais absents des types d'entité upstream. D'où la lecture par clé.

/** Lit `allowedCountries` sur un workspaceMember hydraté, champ custom compris. */
export const readMemberCountryScopeField = (
  workspaceMember: object,
): string | null | undefined =>
  Object.entries(workspaceMember).find(
    ([key]) => key === MEMBER_SCOPE_FIELD,
  )?.[1] as string | null | undefined;

/** Lit `countryCode` sur un enregistrement hydraté (company, person, opportunity…). */
export const readRecordCountryCodeField = (
  record: object,
): string | null | undefined =>
  Object.entries(record).find(([key]) => key === COUNTRY_FIELD)?.[1] as
    | string
    | null
    | undefined;

/**
 * Un enregistrement porteur de `countryCode` est-il dans le périmètre ?
 *
 * Un `countryCode` absent est REFUSÉ hors périmètre « tous pays », pour coller à ce que
 * fait le SQL du choke-point ORM : `countryCode IN (...)` ne retient jamais un NULL.
 */
export const isCountryInScope = (
  scope: CountryScope,
  countryCode: string | null | undefined,
): boolean => {
  if (scope.kind === 'unscoped') {
    return true;
  }

  if (countryCode === null || countryCode === undefined) {
    return false;
  }

  return scope.allowed.includes(countryCode.trim().toUpperCase());
};
