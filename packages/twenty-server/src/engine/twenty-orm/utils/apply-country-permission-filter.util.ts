import { Brackets, type ObjectLiteral } from 'typeorm';
import { isDefined } from 'twenty-shared/utils';

import { GraphqlQueryFilterFieldParser } from 'src/engine/api/graphql/graphql-query-runner/graphql-query-parsers/graphql-query-filter/graphql-query-filter-field.parser';
import { isUserAuthContext } from 'src/engine/core-modules/auth/guards/is-user-auth-context.guard';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { buildFieldMapsFromFlatObjectMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/build-field-maps-from-flat-object-metadata.util';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type WorkspaceInternalContext } from 'src/engine/twenty-orm/interfaces/workspace-internal-context.interface';
import { type WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/repository/workspace-select-query-builder';

// Cloisonnement par pays (AGPL, autonome). Branché au choke-point ORM unique
// `WorkspaceSelectQueryBuilder.validatePermissions()`, après les checks object-level.
// N'importe ni ne réutilise le code Enterprise (`apply-row-level-permission-predicates.util.ts`),
// qui n'est qu'un patron de forme.

const ALL_COUNTRIES = '*';
const COUNTRY_FIELD = 'countryCode';
const MEMBER_SCOPE_FIELD = 'allowedCountries';

// Objets de référence/catalogue sans rattachement pays (pas de donnée client
// confidentielle) : restent visibles par un utilisateur scoppé. TOUT autre objet
// sans `countryCode` est refusé par défaut (default-deny) — secure-by-default :
// un objet ajouté demain est invisible tant qu'il n'est pas explicitement traité
// (countryCode direct) ou ajouté ici. Étendre via les tests UI si une vue casse.
const COUNTRY_AGNOSTIC_OBJECTS = new Set<string>([
  'country', // référentiel des 76 pays
  'product', // catalogue produit (master data, non pays-spécifique)
  'workspaceMember', // annuaire interne Twenty (assignation, mentions, avatars)
]);

type ApplyCountryPermissionFilterArgs<T extends ObjectLiteral> = {
  queryBuilder: WorkspaceSelectQueryBuilder<T>;
  objectMetadata: FlatObjectMetadata;
  internalContext: WorkspaceInternalContext;
  authContext: WorkspaceAuthContext;
};

export const applyCountryPermissionFilter = <T extends ObjectLiteral>({
  queryBuilder,
  objectMetadata,
  internalContext,
  authContext,
}: ApplyCountryPermissionFilterArgs<T>): void => {
  // 1. Bypass : seul un contexte utilisateur est filtré.
  //    Clé API serveur (ingestion) / contexte système ne sont JAMAIS filtrés.
  if (!isUserAuthContext(authContext)) {
    return;
  }

  // 2. Scope de l'utilisateur courant, lu sur le champ custom hydraté du workspaceMember.
  const raw = Object.entries(authContext.workspaceMember).find(
    ([key]) => key === MEMBER_SCOPE_FIELD,
  )?.[1] as string | null | undefined;

  // Cloisonnement NON provisionné dans ce workspace : le champ `allowedCountries`
  // est absent du workspaceMember (workspaces upstream/tests sans le champ Snetor)
  // → no-op total. NB : champ présent mais vide ('' / null) ≠ absent → default-deny
  //   (un membre Snetor sans pays ne voit rien).
  if (raw === undefined) {
    return;
  }

  if (raw === ALL_COUNTRIES) {
    return; // « tous pays » (managers de zone large / ExCom / admins) : pas de filtre
  }

  const allowed = (raw ?? '')
    .split(';')
    .map((iso) => iso.trim().toUpperCase())
    .filter((iso) => iso.length > 0);

  // 3. Objet porteur d'un `countryCode` ? → cloisonnement direct.
  const { fieldIdByName } = buildFieldMapsFromFlatObjectMetadata(
    internalContext.flatFieldMetadataMaps,
    objectMetadata,
  );

  if (isDefined(fieldIdByName[COUNTRY_FIELD])) {
    injectCountryWhere(queryBuilder, objectMetadata, internalContext, allowed);
    return;
  }

  // 4. Objet SANS `countryCode` : référentiel autorisé → visible ; sinon
  //    default-deny. Évite la fuite cross-pays via les objets non rattachés
  //    (salesperson, mission, note/task/attachment/timeline, companyGroup,
  //    calendar/message…). Le filtrage transitif fin de ces objets (ex. notes
  //    des comptes du rep) viendra dans une itération ultérieure.
  if (COUNTRY_AGNOSTIC_OBJECTS.has(objectMetadata.nameSingular)) {
    return;
  }

  denyAll(queryBuilder);
};

const injectCountryWhere = <T extends ObjectLiteral>(
  queryBuilder: WorkspaceSelectQueryBuilder<T>,
  objectMetadata: FlatObjectMetadata,
  internalContext: WorkspaceInternalContext,
  allowed: string[],
): void => {
  // parseKeyFilter (Enterprise, privé) délègue son default case à
  // GraphqlQueryFilterFieldParser.parse — on appelle directement le parser public.
  // Il ne sert que la surface de jointure, on élargit donc à ObjectLiteral.
  const outerQueryBuilder =
    queryBuilder as WorkspaceSelectQueryBuilder<ObjectLiteral>;

  const condition = new Brackets((qb) => {
    if (allowed.length === 0) {
      qb.where('1 = 0'); // default-deny : un sales sans pays ne voit rien
      return;
    }

    const fieldParser = new GraphqlQueryFilterFieldParser(
      objectMetadata,
      internalContext.flatFieldMetadataMaps,
    );

    // `countryCode IN (:...allowed)` via le field parser (gère l'alias + les params)
    fieldParser.parse(
      qb,
      outerQueryBuilder,
      objectMetadata.nameSingular,
      COUNTRY_FIELD,
      { in: allowed },
      true,
      false,
    );
  });

  appendCondition(queryBuilder, condition);
};

// Default-deny : un objet non rattaché à un pays (et hors allowlist) est invisible
// pour un utilisateur scoppé.
const denyAll = <T extends ObjectLiteral>(
  queryBuilder: WorkspaceSelectQueryBuilder<T>,
): void => {
  appendCondition(
    queryBuilder,
    new Brackets((qb) => {
      qb.where('1 = 0');
    }),
  );
};

// Ajoute la condition en AND avec les WHERE existants (ou en WHERE si aucun).
const appendCondition = <T extends ObjectLiteral>(
  queryBuilder: WorkspaceSelectQueryBuilder<T>,
  condition: Brackets,
): void => {
  if (queryBuilder.expressionMap.wheres.length === 0) {
    queryBuilder.where(condition);
  } else {
    queryBuilder.andWhere(condition);
  }
};
