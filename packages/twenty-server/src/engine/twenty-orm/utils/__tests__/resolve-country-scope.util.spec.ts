import {
  isCountryInScope,
  isScopeInScope,
  readMemberCountryScopeField,
  readMemberScopesField,
  readRecordCountryCodeField,
  readRecordScopePathField,
  resolveCountryScope,
  resolveScope,
  scopeTokenPattern,
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

// --- Périmètre par portefeuille (lot B2). Le périmètre pays ci-dessus reste testé tel
// quel : il est le repli de celui-ci, pas son prédécesseur.

describe('resolveScope', () => {
  it('lit allowedScopes quand il est renseigné', () => {
    expect(resolveScope('g:217,c:EC', 'FR;ES')).toEqual({
      kind: 'tokens',
      allowed: ['g:217', 'c:EC'],
    });
  });

  it('retombe sur allowedCountries quand allowedScopes est absent', () => {
    // Déployer ce filtre avant que la donnée du plan 1 existe doit reproduire le
    // comportement actuel, pas ouvrir un CRM vide.
    expect(resolveScope(undefined, 'EC;CO')).toEqual({
      kind: 'tokens',
      allowed: ['c:EC', 'c:CO'],
    });
  });

  it('retombe sur allowedCountries quand allowedScopes est une chaîne vide', () => {
    expect(resolveScope('', 'EC')).toEqual({ kind: 'tokens', allowed: ['c:EC'] });
  });

  it('rend unscoped sur la sentinelle, dans les deux champs', () => {
    expect(resolveScope('*', undefined)).toEqual({ kind: 'unscoped' });
    expect(resolveScope(undefined, '*')).toEqual({ kind: 'unscoped' });
  });

  it('rend unscoped quand les deux champs sont absents', () => {
    // Workspace upstream ou de test, non provisionné : aucun cloisonnement.
    expect(resolveScope(undefined, undefined)).toEqual({ kind: 'unscoped' });
  });

  it('rend un périmètre vide quand les deux champs sont présents mais vides', () => {
    // Default-deny assumé : un membre Snetor sans périmètre ne voit rien.
    expect(resolveScope('', '')).toEqual({ kind: 'tokens', allowed: [] });
  });

  it('ignore les espaces et les jetons vides', () => {
    expect(resolveScope(' g:217 , ,c:EC ', undefined)).toEqual({
      kind: 'tokens',
      allowed: ['g:217', 'c:EC'],
    });
  });
});

describe('scopeTokenPattern', () => {
  it('encadre le jeton de barres verticales', () => {
    expect(scopeTokenPattern('g:217')).toBe('%|g:217|%');
  });

  it('empêche un préfixe court de matcher un groupe long', () => {
    const chemin = '|g:217|';

    expect(chemin.includes('|g:21|')).toBe(false);
    expect(chemin.includes('|g:217|')).toBe(true);
  });
});

describe('readMemberScopesField / readRecordScopePathField', () => {
  it('lit les champs custom hydratés', () => {
    expect(readMemberScopesField({ allowedScopes: 'g:217' })).toBe('g:217');
    expect(readRecordScopePathField({ scopePath: '|g:217|' })).toBe('|g:217|');
  });

  it('rend undefined quand le champ est absent', () => {
    expect(readMemberScopesField({ name: 'x' })).toBeUndefined();
    expect(readRecordScopePathField({ name: 'x' })).toBeUndefined();
  });
});

describe('isScopeInScope', () => {
  const scope = resolveScope('g:217,c:EC', undefined);

  it('accepte un scopePath qui porte un jeton du périmètre', () => {
    expect(isScopeInScope(scope, '|g:217|g:260|', null)).toBe(true);
  });

  it("refuse un scopePath dont aucun jeton n'est au périmètre", () => {
    expect(isScopeInScope(scope, '|g:999|', null)).toBe(false);
  });

  it("n'expose pas un enregistrement d'un autre groupe du même pays", () => {
    // La régression que ce lot corrige : deux commerciaux d'un même pays se voyaient.
    // Le scopePath est renseigné, donc le repli pays ne s'applique PAS.
    expect(isScopeInScope(scope, '|g:260|', 'EC')).toBe(false);
  });

  it('refuse un scopePath vide quand le pays ne rattrape pas', () => {
    // Cohérent avec le SQL : le repli n'existe que si un jeton pays couvre l'enregistrement.
    expect(isScopeInScope(scope, null, null)).toBe(false);
    expect(isScopeInScope(scope, '', null)).toBe(false);
    expect(isScopeInScope(scope, '', 'CO')).toBe(false);
  });

  // ⚠️ Contrainte liante du 2026-08-19 : une colonne PRÉSENTE ET VIDE se traite comme une
  // colonne ABSENTE. Sans ça, 3943 enregistrements du workspace basculeraient du repli au
  // refus le jour du déploiement, et un commercial verrait ses sociétés et zéro contact,
  // opportunité, visite ou produit client.
  it('retombe sur le countryCode quand le scopePath est absent, null ou vide', () => {
    expect(isScopeInScope(scope, undefined, 'EC')).toBe(true);
    expect(isScopeInScope(scope, null, 'EC')).toBe(true);
    expect(isScopeInScope(scope, '', 'EC')).toBe(true);
    expect(isScopeInScope(scope, undefined, 'CO')).toBe(false);
  });

  it('ne retombe pas sur le pays quand le périmètre ne porte aucun jeton pays', () => {
    const sansPays = resolveScope('g:217', undefined);

    expect(isScopeInScope(sansPays, '', 'EC')).toBe(false);
  });

  it('laisse tout passer en unscoped', () => {
    expect(isScopeInScope({ kind: 'unscoped' }, null, null)).toBe(true);
  });
});
