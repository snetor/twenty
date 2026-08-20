import { applyCountryPermissionFilter } from 'src/engine/twenty-orm/utils/apply-country-permission-filter.util';

const makeQb = () => ({
  where: jest.fn(),
  andWhere: jest.fn(),
  expressionMap: { wheres: [] as unknown[] },
});

// objectMetadata + internalContext pour un objet portant un champ `countryCode`.
// buildFieldMapsFromFlatObjectMetadata résout fieldIds -> universalIdentifierById ->
// byUniversalIdentifier (résolution canonique du repo).
const scopedObject = () => ({
  objectMetadata: {
    nameSingular: 'company',
    fieldIds: ['cc-field-id'],
  } as any,
  internalContext: {
    flatFieldMetadataMaps: {
      universalIdentifierById: { 'cc-field-id': 'cc-uid' },
      byUniversalIdentifier: {
        'cc-uid': { id: 'cc-field-id', name: 'countryCode', type: 'TEXT' },
      },
    },
  } as any,
});

// Objet sans champ countryCode mais dans l'allowlist de référence (workspaceMember,
// country, product) : reste visible pour un utilisateur scoppé.
const allowlistedObject = (nameSingular = 'workspaceMember') => ({
  objectMetadata: {
    nameSingular,
    fieldIds: ['name-field-id'],
  } as any,
  internalContext: {
    flatFieldMetadataMaps: {
      universalIdentifierById: { 'name-field-id': 'name-uid' },
      byUniversalIdentifier: {
        'name-uid': { id: 'name-field-id', name: 'name', type: 'TEXT' },
      },
    },
  } as any,
});

// Objet sans champ countryCode (paramétrable). Hors allowlist + hors self-owned
// (ex. mission, attachment) => default-deny ; pour task/note/blocklist avec id =>
// self-owned. NB : `salesperson` est passé dans l'allowlist (annuaire interne).
const objectWithoutCountryCode = (nameSingular = 'mission') => ({
  objectMetadata: {
    nameSingular,
    fieldIds: ['name-field-id'],
  } as any,
  internalContext: {
    flatFieldMetadataMaps: {
      universalIdentifierById: { 'name-field-id': 'name-uid' },
      byUniversalIdentifier: {
        'name-uid': { id: 'name-field-id', name: 'name', type: 'TEXT' },
      },
    },
  } as any,
});

describe('applyCountryPermissionFilter', () => {
  it('ne filtre pas en contexte apiKey/system (bypass)', () => {
    const qb: any = makeQb();
    const { objectMetadata, internalContext } = scopedObject();

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: { type: 'apiKey' } as any,
    });

    expect(qb.where).not.toHaveBeenCalled();
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('ne filtre pas un user « tous pays » (allowedCountries = *)', () => {
    const qb: any = makeQb();
    const { objectMetadata, internalContext } = scopedObject();

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: {
        type: 'user',
        workspaceMember: { allowedCountries: '*' },
      } as any,
    });

    expect(qb.where).not.toHaveBeenCalled();
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('ne filtre pas un objet de référence allowlisté (workspaceMember/country/product)', () => {
    for (const name of ['workspaceMember', 'country', 'product']) {
      const qb: any = makeQb();
      const { objectMetadata, internalContext } = allowlistedObject(name);

      applyCountryPermissionFilter({
        queryBuilder: qb,
        objectMetadata,
        internalContext,
        authContext: {
          type: 'user',
          workspaceMember: { allowedCountries: 'ES' },
        } as any,
      });

      expect(qb.where).not.toHaveBeenCalled();
      expect(qb.andWhere).not.toHaveBeenCalled();
    }
  });

  it('no-op si le champ allowedCountries est absent du workspaceMember (workspace non provisionné)', () => {
    const qb: any = makeQb();
    const { objectMetadata, internalContext } = objectWithoutCountryCode();

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: {
        type: 'user',
        workspaceMember: { name: 'x' }, // pas de champ allowedCountries
      } as any,
    });

    expect(qb.where).not.toHaveBeenCalled();
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('default-deny : objet sans countryCode hors allowlist (mission) => invisible', () => {
    const qb: any = makeQb();
    const { objectMetadata, internalContext } = objectWithoutCountryCode();

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: {
        type: 'user',
        workspaceMember: { allowedCountries: 'ES' },
      } as any,
    });

    expect(qb.where).toHaveBeenCalledTimes(1);
    const brackets = qb.where.mock.calls[0][0];
    const inner = { where: jest.fn(), andWhere: jest.fn() };
    brackets.whereFactory(inner);
    expect(inner.where).toHaveBeenCalledWith('1 = 0');
  });

  it('default-deny objet hors allowlist : andWhere si un where existe déjà', () => {
    const qb: any = makeQb();
    qb.expressionMap.wheres = [{ type: 'simple' }];
    const { objectMetadata, internalContext } = objectWithoutCountryCode();

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: {
        type: 'user',
        workspaceMember: { allowedCountries: 'ES' },
      } as any,
    });

    expect(qb.andWhere).toHaveBeenCalledTimes(1);
    expect(qb.where).not.toHaveBeenCalled();
  });

  it("ne filtre pas l'annuaire commercial ni les dashboards", () => {
    for (const name of ['salesperson', 'salespersonCountry', 'dashboard']) {
      const qb: any = makeQb();
      const { objectMetadata, internalContext } = allowlistedObject(name);

      applyCountryPermissionFilter({
        queryBuilder: qb,
        objectMetadata,
        internalContext,
        authContext: {
          type: 'user',
          workspaceMember: { id: 'me-123', allowedCountries: 'ES' },
        } as any,
      });

      expect(qb.where).not.toHaveBeenCalled();
      expect(qb.andWhere).not.toHaveBeenCalled();
    }
  });

  // Le contenu de la messagerie et de l'agenda reste refusé : décision métier du
  // 2026-08-10, un commercial ne voit pas les mails ni l'agenda de ses collègues. Ces
  // objets vivent bien dans le workspace et portent la donnée sensible.
  it("default-deny maintenu sur le contenu de la messagerie et de l'agenda", () => {
    for (const name of [
      'message',
      'messageThread',
      'messageParticipant',
      'messageChannelMessageAssociation',
      'calendarEvent',
      'calendarEventParticipant',
      'calendarChannelEventAssociation',
    ]) {
      const qb: any = makeQb();
      const { objectMetadata, internalContext } =
        objectWithoutCountryCode(name);

      applyCountryPermissionFilter({
        queryBuilder: qb,
        objectMetadata,
        internalContext,
        authContext: {
          type: 'user',
          workspaceMember: { id: 'me-123', allowedCountries: 'ES' },
        } as any,
      });

      const brackets = qb.where.mock.calls[0][0];
      const inner = { where: jest.fn(), andWhere: jest.fn() };

      brackets.whereFactory(inner);
      expect(inner.where).toHaveBeenCalledWith('1 = 0');
    }
  });

  // Coquilles : leurs données ont migré dans le schéma `core` avec `connectedAccount`.
  // Le refus est conservé — un objet non classé doit rester invisible — mais il ne protège
  // rien : mesuré le 2026-08-11, ces trois objets renvoient 0 ligne alors que 3 canaux
  // réels importent. Ce test existe pour que la raison ne se reperde pas.
  it('default-deny conservé sur les objets vidés au profit du schéma core', () => {
    for (const name of ['messageChannel', 'calendarChannel', 'messageFolder']) {
      const qb: any = makeQb();
      const { objectMetadata, internalContext } =
        objectWithoutCountryCode(name);

      applyCountryPermissionFilter({
        queryBuilder: qb,
        objectMetadata,
        internalContext,
        authContext: {
          type: 'user',
          workspaceMember: { id: 'me-123', allowedCountries: 'ES' },
        } as any,
      });

      const brackets = qb.where.mock.calls[0][0];
      const inner = { where: jest.fn(), andWhere: jest.fn() };

      brackets.whereFactory(inner);
      expect(inner.where).toHaveBeenCalledWith('1 = 0');
    }
  });

  it('self-owned : blocklist filtrée sur le membre courant', () => {
    const qb: any = makeQb();
    const { objectMetadata, internalContext } =
      objectWithoutCountryCode('blocklist');

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: {
        type: 'user',
        workspaceMember: { id: 'me-123', allowedCountries: 'ES' },
      } as any,
    });

    expect(qb.where).toHaveBeenCalledTimes(1);
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('self-owned : task avec workspaceMember.id => filtre par appartenance pose (pas un deny)', () => {
    const qb: any = makeQb();
    const { objectMetadata, internalContext } =
      objectWithoutCountryCode('task');

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: {
        type: 'user',
        workspaceMember: { id: 'me-123', allowedCountries: 'ES' },
      } as any,
    });

    // une condition est posée (le filtre assignee=moi), pas un no-op
    expect(qb.where).toHaveBeenCalledTimes(1);
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('self-owned : task SANS workspaceMember.id => default-deny', () => {
    const qb: any = makeQb();
    const { objectMetadata, internalContext } =
      objectWithoutCountryCode('task');

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: {
        type: 'user',
        workspaceMember: { allowedCountries: 'ES' }, // pas d'id
      } as any,
    });

    expect(qb.where).toHaveBeenCalledTimes(1);
    const brackets = qb.where.mock.calls[0][0];
    const inner = { where: jest.fn(), andWhere: jest.fn() };
    brackets.whereFactory(inner);
    expect(inner.where).toHaveBeenCalledWith('1 = 0');
  });

  it('injecte un filtre countryCode pour un user scopé', () => {
    const qb: any = makeQb();
    const { objectMetadata, internalContext } = scopedObject();

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: {
        type: 'user',
        workspaceMember: { allowedCountries: 'ES;CO' },
      } as any,
    });

    expect(qb.where).toHaveBeenCalledTimes(1); // un Brackets posé (premier where)
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('andWhere quand le queryBuilder a déjà un where', () => {
    const qb: any = makeQb();
    qb.expressionMap.wheres = [{ type: 'simple' }];
    const { objectMetadata, internalContext } = scopedObject();

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: {
        type: 'user',
        workspaceMember: { allowedCountries: 'ES' },
      } as any,
    });

    expect(qb.andWhere).toHaveBeenCalledTimes(1);
    expect(qb.where).not.toHaveBeenCalled();
  });

  it('default-deny : allowedCountries vide => condition impossible posée', () => {
    const qb: any = makeQb();
    const { objectMetadata, internalContext } = scopedObject();

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: {
        type: 'user',
        workspaceMember: { allowedCountries: '' },
      } as any,
    });

    // une condition (WHERE 1=0) est posée -> l'objet devient invisible
    expect(qb.where).toHaveBeenCalledTimes(1);
  });

  it('default-deny : le Brackets posé exécute `1 = 0` quand allowed est vide', () => {
    const qb: any = makeQb();
    const { objectMetadata, internalContext } = scopedObject();

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: {
        type: 'user',
        workspaceMember: { allowedCountries: '   ' },
      } as any,
    });

    // exécute le callback du Brackets posé (whereFactory en typeorm) pour vérifier
    // le predicat default-deny, sans toucher à une vraie base.
    const brackets = qb.where.mock.calls[0][0];
    const inner = { where: jest.fn(), andWhere: jest.fn() };

    brackets.whereFactory(inner);

    expect(inner.where).toHaveBeenCalledWith('1 = 0');
  });
});

// --- Cloisonnement par portefeuille (lot B2).
//
// Ces tests rendent le SQL réellement produit plutôt que de compter des appels : la
// propriété de sécurité est dans le prédicat, pas dans la forme. `renderSql` déroule
// récursivement les `Brackets` posés et parenthèse chaque niveau, exactement comme
// TypeORM le fait à l'exécution.

// oxlint-disable-next-line typescript/no-unsafe-function-type
const isBrackets = (value: unknown): value is { whereFactory: Function } =>
  typeof (value as { whereFactory?: unknown })?.whereFactory === 'function';

const renderSql = (condition: unknown): string => {
  if (!isBrackets(condition)) {
    return String(condition);
  }

  const parts: string[] = [];
  const recorder = {
    where: (arg: unknown) => {
      parts.push(renderSql(arg));

      return recorder;
    },
    andWhere: (arg: unknown) => {
      parts.push(`AND ${renderSql(arg)}`);

      return recorder;
    },
    orWhere: (arg: unknown) => {
      parts.push(`OR ${renderSql(arg)}`);

      return recorder;
    },
  };

  condition.whereFactory(recorder);

  return `(${parts.join(' ')})`;
};

// Rejoue les Brackets posés pour collecter les paramètres liés au SQL.
const collectParams = (condition: unknown): object[] => {
  const params: object[] = [];
  const walk = (node: unknown): void => {
    if (!isBrackets(node)) {
      return;
    }

    const rec = {
      // oxlint-disable-next-line typescript/no-explicit-any
      where: (arg: any, bound: any) => {
        isBrackets(arg) ? walk(arg) : bound && params.push(bound);

        return rec;
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      andWhere: (arg: any, bound: any) => {
        isBrackets(arg) ? walk(arg) : bound && params.push(bound);

        return rec;
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      orWhere: (arg: any, bound: any) => {
        isBrackets(arg) ? walk(arg) : bound && params.push(bound);

        return rec;
      },
    };

    node.whereFactory(rec);
  };

  walk(condition);

  return params;
};

// Objet portant `scopePath` ET `countryCode` : c'est le cas de `company` sur le
// workspace réel.
const portfolioObject = (nameSingular = 'company') => ({
  objectMetadata: {
    id: 'company-object-id',
    nameSingular,
    fieldIds: ['sp-field-id', 'cc-field-id'],
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any,
  internalContext: {
    flatFieldMetadataMaps: {
      universalIdentifierById: {
        'sp-field-id': 'sp-uid',
        'cc-field-id': 'cc-uid',
      },
      byUniversalIdentifier: {
        'sp-uid': { id: 'sp-field-id', name: 'scopePath', type: 'TEXT' },
        'cc-uid': { id: 'cc-field-id', name: 'countryCode', type: 'TEXT' },
      },
    },
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any,
});

// oxlint-disable-next-line typescript/no-explicit-any
const userWith = (workspaceMember: object): any => ({
  type: 'user',
  workspaceMember,
});

describe('cloisonnement par scopePath', () => {
  // oxlint-disable-next-line typescript/no-explicit-any
  const runFilter = (authContext: any, object = portfolioObject()) => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const qb: any = makeQb();

    qb.objectRecordsPermissions = {};

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata: object.objectMetadata,
      internalContext: object.internalContext,
      authContext,
    });

    const posted = qb.where.mock.calls[0]?.[0] ?? qb.andWhere.mock.calls[0]?.[0];

    return { qb, posted, sql: posted === undefined ? '' : renderSql(posted) };
  };

  it('filtre sur scopePath par un OU de ILIKE, une clause par jeton', () => {
    const { sql } = runFilter(userWith({ allowedScopes: 'g:217,g:260' }));

    expect(sql).toContain('"company"."scopePath"::text ILIKE');
    // Deux jetons, deux clauses reliées par OU. C'est ce qui rend le multi-porteur
    // possible : un client sur trois est servi par plus d'un groupe de vendeurs.
    expect(sql.match(/ILIKE/g)).toHaveLength(2);
    expect(sql).toContain('OR (');
  });

  it('lie le motif encadré de barres, jamais le jeton nu', () => {
    const { posted } = runFilter(userWith({ allowedScopes: 'g:217' }));
    const params = JSON.stringify(collectParams(posted));

    expect(params).toContain('%|g:217|%');
    // L'encadrement est ce qui empêche `g:21` de matcher `g:217`.
    expect(params).not.toContain('"g:217"');
  });

  // ⚠️ Contrainte liante du 2026-08-19 : une colonne PRÉSENTE ET VIDE vaut une colonne
  // ABSENTE. Sans cette branche, 3943 enregistrements du workspace basculent du repli au
  // refus le jour du déploiement, et un commercial voit ses sociétés et zéro contact.
  it('ajoute le repli pays pour un scopePath vide ou NULL', () => {
    const { sql } = runFilter(
      userWith({ allowedScopes: 'g:217,c:EC', allowedCountries: 'EC' }),
    );

    expect(sql).toContain('"company"."scopePath" IS NULL');
    expect(sql).toContain('"company"."scopePath" = :scopePath');
    expect(sql).toContain('"company"."countryCode" IN');
    // La précédence, et c'est tout l'enjeu : le repli entier est en OU des jetons, et
    // à l'intérieur la nullité est en ET du pays. Sans les parenthèses posées par chaque
    // Brackets, `A IS NULL OR A = '' AND cc IN (…)` se lirait à l'envers et exposerait
    // tous les enregistrements NULL, quel que soit leur pays.
    expect(sql).toContain('OR (("company"."scopePath" IS NULL');
    expect(sql).toContain('AND ("company"."countryCode" IN');
  });

  it("n'ajoute aucun repli quand le périmètre ne porte aucun jeton pays", () => {
    const { sql } = runFilter(userWith({ allowedScopes: 'g:217' }));

    expect(sql).not.toContain('IS NULL');
    expect(sql).not.toContain('countryCode');
  });

  it('reproduit le filtre pays quand le membre n a pas encore d allowedScopes', () => {
    // Déployer avant que la donnée de portée existe doit reproduire le comportement
    // actuel : jetons pays uniquement, donc aucune fuite et aucun CRM vide.
    const { sql } = runFilter(userWith({ allowedCountries: 'EC;CO' }));

    expect(sql).toContain('"company"."scopePath" IS NULL');
    expect(sql).toContain('"company"."countryCode" IN');
    expect(sql.match(/ILIKE/g)).toHaveLength(2); // c:EC et c:CO
  });

  it('reste sur countryCode pour un objet qui ne porte pas encore scopePath', () => {
    const { objectMetadata, internalContext } = scopedObject();
    // oxlint-disable-next-line typescript/no-explicit-any
    const qb: any = makeQb();

    qb.objectRecordsPermissions = {};

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: userWith({ allowedScopes: 'g:217,c:EC' }),
    });

    const sql = renderSql(qb.where.mock.calls[0][0]);

    expect(sql).not.toContain('ILIKE');
    expect(sql).toContain('"company"."countryCode" IN');
  });

  it('refuse tout sur un objet countryCode quand le périmètre n a que des groupes', () => {
    // Aucun jeton pays : rien ne peut rattraper un objet qui ne porte pas de scopePath.
    const { objectMetadata, internalContext } = scopedObject();
    // oxlint-disable-next-line typescript/no-explicit-any
    const qb: any = makeQb();

    qb.objectRecordsPermissions = {};

    applyCountryPermissionFilter({
      queryBuilder: qb,
      objectMetadata,
      internalContext,
      authContext: userWith({ allowedScopes: 'g:217' }),
    });

    expect(renderSql(qb.where.mock.calls[0][0])).toBe('(1 = 0)');
  });

  it('default-deny : périmètre vide sur les deux champs, objet invisible', () => {
    const { sql } = runFilter(
      userWith({ allowedScopes: '', allowedCountries: '' }),
    );

    expect(sql).toBe('(1 = 0)');
  });

  it('ne filtre jamais une clé API, même sur un objet porteur de scopePath', () => {
    // L'ingestion écrit hors périmètre : ce bypass est une condition de service.
    // oxlint-disable-next-line typescript/no-explicit-any
    const { qb } = runFilter({ type: 'apiKey' } as any);

    expect(qb.where).not.toHaveBeenCalled();
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('ne filtre pas un membre non cloisonné (sentinelle sur allowedScopes)', () => {
    const { qb } = runFilter(userWith({ allowedScopes: '*' }));

    expect(qb.where).not.toHaveBeenCalled();
    expect(qb.andWhere).not.toHaveBeenCalled();
  });
});
