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
  // Annuaire commercial interne : mêmes données que workspaceMember, vues du métier
  // (nom, email, territoire). Refuser `salesperson` alors que `workspaceMember` est
  // visible n'apportait aucune confidentialité et cassait toute vue portant le nom
  // du commercial.
  'salesperson',
  'salespersonCountry', // jonction commercial <-> pays du même annuaire
  // Objet de configuration : un dashboard ne porte pas de donnée client, ses widgets
  // interrogent les objets métier, qui restent filtrés à la source.
  'dashboard',
]);

// Objets « personnels » sans countryCode : un utilisateur scoppé voit SES propres
// enregistrements (ceux où il est impliqué), via un filtre d'appartenance par
// identité du membre courant. Le reste (notes/tâches d'autrui ou rattachées à des
// comptes hors scope) reste default-deny ; le transitif via les comptes in-scope
// du rep viendra en itération ultérieure (cf. audit).
const SELF_OWNED_FILTERS: Record<
  string,
  (workspaceMemberId: string) => { field: string; filter: object }
> = {
  task: (id) => ({ field: 'assigneeId', filter: { eq: id } }),
  note: (id) => ({
    field: 'createdBy',
    filter: { workspaceMemberId: { eq: id } },
  }),
  // Liste d'exclusion de synchronisation : donnée strictement personnelle, portée
  // par une FK directe vers le membre.
  blocklist: (id) => ({ field: 'workspaceMemberId', filter: { eq: id } }),
};

// ⚠️ Restent en default-deny, et c'est un manque assumé, pas un oubli. Mais la famille
// messagerie/agenda demande une distinction que ce commentaire affirmait à tort, et qui
// change la conception du lot B — mesuré sur DEV le 2026-08-11 :
//
// - `messageChannel`, `calendarChannel` et `messageFolder` sont des **coquilles** : leurs
//   données ont migré dans le schéma `core` (avec `connectedAccount`), hors du périmètre de
//   l'ORM workspace. Les objets de métadonnées existent encore et renvoient **0 ligne**,
//   alors que 3 canaux réels sont actifs et importent. Les refuser ici ne protège donc
//   RIEN, et c'est précisément pour ça que `messageChannel` n'expose plus de
//   `connectedAccountId` : le chemin `messageChannel -> connectedAccount.accountOwnerId`,
//   que ce commentaire proposait comme filtre d'appartenance, **n'existe pas** sur cette
//   surface. Corollaire : la visibilité native par canal
//   (`MessageChannelVisibility`, appliquée dans `timeline-messaging.service.ts`) vit dans
//   `core` et ce filtre ne peut pas la contredire.
//
// - le contenu, lui, est bien dans le workspace et bien refusé : `message`,
//   `messageThread`, `messageParticipant`, `messageChannelMessageAssociation`,
//   `messageChannelMessageAssociationMessageFolder`, `calendarEvent`,
//   `calendarEventParticipant`, `calendarChannelEventAssociation`. C'est là que se joue la
//   confidentialité, et la seule FK directe vers un membre de toute la famille est
//   `messageParticipant.workspaceMemberId` (et son équivalent
//   `calendarEventParticipant.workspaceMemberId`). Un filtre bâti sur elles seules rendrait
//   visibles deux objets de jonction et aucun message : la vraie réponse reste une colonne
//   dénormalisée, comme `scopePath` du lot B. À traiter là, pas par une rustine ici.
//
// - objets rattachés à un enregistrement client (`attachment`, `timelineActivity`,
//   `noteTarget`, `taskTarget`, `visitContact`, `mission`, `companyGroup`) : leur
//   portée est celle de leur parent. Même conclusion, même lot.
//
// Conséquence à connaître tant que ce n'est pas fait : un commercial scoppé n'a ni pièces
// jointes, ni historique, ni missions, et ne peut lire ni message ni événement d'agenda par
// une requête d'objet.
//
// ⚠️ Avant de lever ce refus, connaître ce qui a été mesuré le 2026-08-11 sur la requête
// d'objet générique `messages`, avec un contexte qui n'est pas propriétaire du canal :
// `subject` et `text` reviennent tous deux à la valeur
// `FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED`, alors que `receivedAt` reste lisible.
// La visibilité native par canal s'applique donc **au-delà de l'onglet Emails** : lever le
// refus ici exposerait les métadonnées (dates, fils, participants) mais pas le contenu, tant
// que la visibilité du canal n'est pas `SHARE_EVERYTHING`. C'est une option de conception
// réelle, moins chère que la colonne dénormalisée — mais elle se décide sur la valeur
// effective de `MessageChannelVisibility`, qui vit dans `core` et n'est lisible ni par ce
// filtre ni par une clé API. À trancher depuis Settings → Accounts, pas depuis ce fichier.

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
    if (allowed.length === 0) {
      denyAll(queryBuilder); // sales sans pays : ne voit rien
    } else {
      injectFieldFilter(queryBuilder, objectMetadata, internalContext, {
        field: COUNTRY_FIELD,
        filter: { in: allowed },
      });
    }
    return;
  }

  // 4. Objet SANS `countryCode` : référentiel autorisé → visible.
  if (COUNTRY_AGNOSTIC_OBJECTS.has(objectMetadata.nameSingular)) {
    return;
  }

  // 4b. Objet « personnel » (note/task) : l'utilisateur voit SES enregistrements.
  const selfOwned = SELF_OWNED_FILTERS[objectMetadata.nameSingular];
  const workspaceMemberId = (authContext.workspaceMember as { id?: string }).id;

  if (selfOwned && isDefined(workspaceMemberId)) {
    injectFieldFilter(
      queryBuilder,
      objectMetadata,
      internalContext,
      selfOwned(workspaceMemberId),
    );
    return;
  }

  // 4c. Tout le reste (salesperson, mission, attachment, companyGroup,
  //     calendar/message…) → default-deny. Secure-by-default.
  denyAll(queryBuilder);
};

// Injecte `WHERE <field> <filter>` via le field parser GraphQL (gère l'alias, les
// params, les champs composites comme `createdBy`). Utilisé pour countryCode
// (`{ in: [...] }`) comme pour l'appartenance (`assigneeId`/`createdBy`).
const injectFieldFilter = <T extends ObjectLiteral>(
  queryBuilder: WorkspaceSelectQueryBuilder<T>,
  objectMetadata: FlatObjectMetadata,
  internalContext: WorkspaceInternalContext,
  { field, filter }: { field: string; filter: object },
): void => {
  // parseKeyFilter (Enterprise, privé) délègue son default case à
  // GraphqlQueryFilterFieldParser.parse — on appelle directement le parser public.
  // Il ne sert que la surface de jointure, on élargit donc à ObjectLiteral.
  const outerQueryBuilder =
    queryBuilder as WorkspaceSelectQueryBuilder<ObjectLiteral>;

  const condition = new Brackets((qb) => {
    const fieldParser = new GraphqlQueryFilterFieldParser(
      objectMetadata,
      internalContext.flatFieldMetadataMaps,
    );

    fieldParser.parse(
      qb,
      outerQueryBuilder,
      objectMetadata.nameSingular,
      field,
      filter,
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
