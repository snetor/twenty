import {
  assertNoActivityOnSalespersonFromUser,
  CommonCreateManyQueryRunnerService,
} from 'src/engine/api/common/common-query-runners/common-create-many-query-runner/common-create-many-query-runner.service';

jest.mock(
  'src/engine/api/graphql/graphql-query-runner/utils/build-columns-to-select',
  () => ({ buildColumnsToSelect: jest.fn(() => ({ id: true })) }),
);

// Snetor — les deux gestes du 2026-09-24 sur la création, cf. le service.

const chainable = () => {
  const qb: any = {};

  for (const method of ['setFindOptions', 'where', 'withDeleted', 'take']) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getMany = jest.fn(async () => [{ id: 'b' }, { id: 'a' }]);

  return qb;
};

const fetch = async (isInsertOnly: boolean) => {
  const service = Object.create(CommonCreateManyQueryRunnerService.prototype);
  const repository = {
    createQueryBuilder: jest.fn(chainable),
    createQueryBuilderForOwnInserts: jest.fn(chainable),
  };

  const records = await service.fetchUpsertedRecords({
    objectRecords: { generatedMaps: [{ id: 'a' }, { id: 'b' }] },
    flatObjectMetadata: { nameSingular: 'note' },
    flatObjectMetadataMaps: {},
    flatFieldMetadataMaps: {},
    repository,
    selectedFieldsResult: { select: {}, relations: {} },
    isInsertOnly,
  });

  return { repository, records };
};

describe('Création — relecture des lignes créées', () => {
  it('une CRÉATION relit ses lignes hors cloisonnement (sinon 0 ligne et erreur)', async () => {
    const { repository, records } = await fetch(true);

    expect(repository.createQueryBuilderForOwnInserts).toHaveBeenCalledTimes(1);
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    expect(records.map((record: { id: string }) => record.id)).toEqual(['a', 'b']);
  });

  it('un UPSERT reste filtré : il peut tomber sur une ligne existante hors périmètre', async () => {
    const { repository } = await fetch(false);

    expect(repository.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(repository.createQueryBuilderForOwnInserts).not.toHaveBeenCalled();
  });
});

describe('Création — pas de note ni de tâche sur un commercial depuis l écran', () => {
  const user = { type: 'user' } as any;
  const apiKey = { type: 'apiKey' } as any;

  it.each(['noteTarget', 'taskTarget'])(
    'refuse une jonction %s vers un salesperson pour un utilisateur',
    (objectName) => {
      expect(() =>
        assertNoActivityOnSalespersonFromUser(
          objectName,
          [{ noteId: 'n1', targetSalespersonId: 's1' }],
          user,
        ),
      ).toThrow(/salesperson/);
    },
  );

  it('laisse passer une jonction vers une société', () => {
    expect(() =>
      assertNoActivityOnSalespersonFromUser(
        'noteTarget',
        [{ noteId: 'n1', targetCompanyId: 'c1' }],
        user,
      ),
    ).not.toThrow();
  });

  it('laisse passer la clé API (ingestion) et les autres objets', () => {
    expect(() =>
      assertNoActivityOnSalespersonFromUser(
        'noteTarget',
        [{ targetSalespersonId: 's1' }],
        apiKey,
      ),
    ).not.toThrow();
    expect(() =>
      assertNoActivityOnSalespersonFromUser(
        'note',
        [{ targetSalespersonId: 's1' }],
        user,
      ),
    ).not.toThrow();
  });
});
