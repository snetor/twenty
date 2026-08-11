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
