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

// --- Périmètre par portefeuille (lot B2). Généralise le périmètre pays : un périmètre est
// une liste de JETONS, `g:<groupe de vendeurs SAP>` ou `c:<ISO pays>`.
//
// ⚠️ Le format est un CONTRAT avec `client-matrix/ingestion/src/scope_tokens.py`, qui écrit
// `company.scopePath`, `salesperson.scopeTokens` et `workspaceMember.allowedScopes`. Une
// divergence entre les deux dépôts est un trou de sécurité qui ne se voit pas : ni le
// compilateur ni les tests des deux côtés ne peuvent l'attraper.

export const MEMBER_SCOPES_FIELD = 'allowedScopes';
export const SCOPE_PATH_FIELD = 'scopePath';
export const COUNTRY_TOKEN_PREFIX = 'c:';
const TOKEN_FRAME = '|';
const MEMBER_TOKEN_SEP = ',';

export type Scope =
  | { kind: 'unscoped' }
  | { kind: 'tokens'; allowed: string[] };

/**
 * Périmètre effectif d'un membre.
 *
 * ⚠️ `allowedScopes` absent OU vide retombe sur `allowedCountries`, converti en jetons
 * pays. C'est volontaire et c'est la sécurité du déploiement : livrer ce filtre avant que
 * la donnée de portée existe reproduit exactement le cloisonnement actuel, au lieu
 * d'ouvrir un CRM vide à tout le monde.
 *
 * Les deux champs absents = workspace non provisionné = aucun cloisonnement.
 * Les deux présents et vides = default-deny : le membre ne voit rien.
 */
export const resolveScope = (
  rawScopes: string | null | undefined,
  rawCountries: string | null | undefined,
): Scope => {
  if (rawScopes?.trim() === ALL_COUNTRIES || rawCountries === ALL_COUNTRIES) {
    return { kind: 'unscoped' };
  }

  const scopes = (rawScopes ?? '')
    .split(MEMBER_TOKEN_SEP)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (scopes.length > 0) {
    return { kind: 'tokens', allowed: scopes };
  }

  // Repli pays. Les deux champs `undefined` = workspace non provisionné.
  if (rawScopes === undefined && rawCountries === undefined) {
    return { kind: 'unscoped' };
  }

  const country = resolveCountryScope(rawCountries);

  if (country.kind === 'unscoped') {
    return rawScopes === undefined
      ? { kind: 'unscoped' }
      : { kind: 'tokens', allowed: [] };
  }

  return {
    kind: 'tokens',
    allowed: country.allowed.map((iso) => `${COUNTRY_TOKEN_PREFIX}${iso}`),
  };
};

/** Motif `ILIKE` d'un jeton. L'encadrement empêche `g:21` de matcher `g:217`. */
export const scopeTokenPattern = (token: string): string =>
  `%${TOKEN_FRAME}${token}${TOKEN_FRAME}%`;

/** Les seuls ISO pays d'un périmètre, pour le repli sur `countryCode`. */
export const countryIsosOfScope = (allowed: string[]): string[] =>
  allowed
    .filter((token) => token.startsWith(COUNTRY_TOKEN_PREFIX))
    .map((token) => token.slice(COUNTRY_TOKEN_PREFIX.length));

/** Lit `allowedScopes` sur un workspaceMember hydraté, champ custom compris. */
export const readMemberScopesField = (
  workspaceMember: object,
): string | null | undefined =>
  Object.entries(workspaceMember).find(
    ([key]) => key === MEMBER_SCOPES_FIELD,
  )?.[1] as string | null | undefined;

/** Lit `scopePath` sur un enregistrement hydraté. */
export const readRecordScopePathField = (
  record: object,
): string | null | undefined =>
  Object.entries(record).find(([key]) => key === SCOPE_PATH_FIELD)?.[1] as
    | string
    | null
    | undefined;

/**
 * Un enregistrement est-il dans le périmètre ? Version en mémoire, pour les chemins en
 * contexte système que le choke-point ORM laisse passer (onglet Emails, agenda).
 *
 * ⚠️ Une colonne `scopePath` PRÉSENTE ET VIDE se traite exactement comme une colonne
 * ABSENTE : repli sur `countryCode`. Mesuré le 2026-08-19 — `scopePath` n'est écrit que
 * sur `company`, donc 3943 enregistrements du workspace ont la colonne vide avec un pays.
 * Les refuser ferait voir à un commercial ses sociétés et zéro contact, opportunité,
 * visite ou produit client. Le refus est réservé au cas où le repli lui-même ne donne rien.
 *
 * Suit exactement le SQL de `applyCountryPermissionFilter` — une divergence entre les deux
 * points d'application est un trou de sécurité silencieux.
 */
export const isScopeInScope = (
  scope: Scope,
  scopePath: string | null | undefined,
  countryCode: string | null | undefined,
): boolean => {
  if (scope.kind === 'unscoped') {
    return true;
  }

  if (
    scopePath === undefined ||
    scopePath === null ||
    scopePath.trim().length === 0
  ) {
    return isCountryInScope(
      { kind: 'countries', allowed: countryIsosOfScope(scope.allowed) },
      countryCode,
    );
  }

  return scope.allowed.some((token) =>
    scopePath.includes(`${TOKEN_FRAME}${token}${TOKEN_FRAME}`),
  );
};
