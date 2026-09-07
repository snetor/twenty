import { GroupByWithRecordsService } from 'src/engine/api/graphql/graphql-query-runner/group-by/services/group-by-with-records.service';

// 🔴 La sous-requête du groupBy est sérialisée en SQL brut par `getQuery()`, qui n'est pas
// surchargée dans `WorkspaceSelectQueryBuilder` : `validatePermissions()` ne tourne donc
// jamais, et seul le prédicat row-level upstream était posé à la main. Kanban et Calendrier
// remontaient des enregistrements hors périmètre. Ce test garde le rappel des DEUX
// prédicats — le seul endroit du code où le cloisonnement dépend d'un appel explicite.
//
// Le builder est un double chaînable : la vraie construction SQL demande une connexion
// DataSource, et ce n'est pas elle qu'on vérifie ici.
const makeChainableQueryBuilder = () => {
  // oxlint-disable-next-line typescript/no-explicit-any
  const qb: any = {
    expressionMap: { parameters: {}, aliases: [{ subQuery: 'sub' }] },
    applyRowLevelPermissionPredicatesToMainAliasAndJoinedRelations: jest.fn(),
    applyCountryPermissionFilterPredicate: jest.fn(),
    getQuery: jest.fn(() => 'SELECT 1'),
    getParameters: jest.fn(() => ({})),
  };

  for (const method of [
    'select',
    'addSelect',
    'andWhere',
    'where',
    'from',
    'groupBy',
    'setParameters',
    'setParameter',
    'limit',
  ]) {
    qb[method] = jest.fn(() => qb);
  }

  return qb;
};

const callAddPartitionBy = (
  // oxlint-disable-next-line typescript/no-explicit-any
  queryBuilderForSubQuery: any,
) => {
  const service = Object.create(
    GroupByWithRecordsService.prototype,
    // oxlint-disable-next-line typescript/no-explicit-any
  ) as any;

  return service.addPartitionByToQueryBuilder({
    queryBuilderForSubQuery,
    columnsToSelect: { name: true },
    groupsResult: [{ stage_alias: 'NEW' }],
    groupByDefinitions: [
      { alias: 'stage_alias', expression: '"company"."stage"' },
    ],
    repository: { createQueryBuilder: () => makeChainableQueryBuilder() },
    orderByForRecords: {},
    flatObjectMetadata: { nameSingular: 'company', fieldIds: [] },
    flatObjectMetadataMaps: {},
    flatFieldMetadataMaps: {},
  });
};

describe('GroupByWithRecordsService — cloisonnement de la sous-requête', () => {
  it('rappelle le prédicat de portée sur la sous-requête sérialisée', () => {
    const subQueryBuilder = makeChainableQueryBuilder();

    callAddPartitionBy(subQueryBuilder);

    expect(
      subQueryBuilder.applyCountryPermissionFilterPredicate,
    ).toHaveBeenCalledTimes(1);
  });

  // ⚠️ L'ordre compte : `getQuery()` figerait le SQL sans le prédicat s'il était appelé
  // avant. Les deux prédicats doivent être posés d'abord.
  it('pose le prédicat avant de sérialiser la sous-requête', () => {
    const order: string[] = [];
    const subQueryBuilder = makeChainableQueryBuilder();

    subQueryBuilder.applyCountryPermissionFilterPredicate.mockImplementation(
      () => {
        order.push('scope');
      },
    );
    subQueryBuilder.getQuery.mockImplementation(() => {
      order.push('getQuery');

      return 'SELECT 1';
    });

    callAddPartitionBy(subQueryBuilder);

    expect(order).toEqual(['scope', 'getQuery']);
  });
});
