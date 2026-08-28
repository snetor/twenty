import { Injectable, Logger } from '@nestjs/common';

import { type ObjectLiteral } from 'typeorm';
import { type ObjectRecordCreateEvent } from 'twenty-shared/database-events';
import { isDefined } from 'twenty-shared/utils';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace.repository';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import {
  buildRecordScopePath,
  MEMBER_SCOPE_FIELD,
  MEMBER_SCOPES_FIELD,
  readMemberCountryScopeField,
  readMemberScopesField,
  resolveScope,
  SCOPE_PATH_FIELD,
} from 'src/engine/twenty-orm/utils/resolve-country-scope.util';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';

// Poser `scopePath` à la NAISSANCE de l'enregistrement.
//
// **Le problème.** Le cloisonnement est un filtre de LECTURE, branché sur
// `WorkspaceSelectQueryBuilder.validatePermissions()`. Il n'intercepte aucune écriture, donc
// un commercial peut parfaitement créer une société — mais elle naît sans `scopePath` et
// sans `countryCode`, et à la relecture aucune branche du filtre ne la retient : ni les
// `ILIKE` sur les jetons, ni le repli pays (qui n'est même pas émis quand le périmètre du
// membre ne contient aucun jeton `c:`). La ligne apparaît une seconde dans l'écran puis
// s'évapore au rafraîchissement, et le commercial en conclut que l'outil a planté et
// recommence.
//
// `scopePath` n'était écrit que par le recalcul par lot (`compute_scope_paths.py`), qui
// tourne à la main. Entre la création et ce passage, l'enregistrement n'existe pour
// personne — y compris pour celui qui vient de le taper.
//
// **La correction.** Recopier le périmètre du créateur sur ce qu'il crée. Même patron que
// `ScopeAssignmentListener`, qui fait déjà exactement ça pour les comptes : un listener
// survit aux fusions de l'upstream, un patch de méthode non.
//
// ⚠️ **Ce listener ne décide de rien.** Il ne fait que rendre visible à son auteur ce que
// le recalcul par lot lui aurait de toute façon attribué. Il n'élargit aucun périmètre : les
// jetons posés sont ceux que le créateur porte déjà.
@Injectable()
export class ScopePathOnCreateListener {
  private readonly logger = new Logger(ScopePathOnCreateListener.name);

  constructor(
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
  ) {}

  @OnDatabaseBatchEvent('company', DatabaseEventAction.CREATED)
  async handleCompanyCreate(
    payload: WorkspaceEventBatch<ObjectRecordCreateEvent>,
  ): Promise<void> {
    await this.handle(payload, undefined);
  }

  // ⚠️ Les quatre objets dépendants héritent de LEUR SOCIÉTÉ, pas de leur créateur — et la
  // relation ne s'appelle pas pareil partout (`client` sur visit et clientProduct,
  // `company` sur person et opportunity). Lu sur le modèle, pas deviné.
  //
  // Pourquoi le parent et non le créateur : un membre peut porter PLUS de jetons que la
  // société sur laquelle il travaille. Poser ses jetons à lui sur un contact rendrait ce
  // contact visible à des collègues qui ne voient pas la société — un enfant plus visible
  // que son parent, c'est-à-dire une fuite. C'est la règle qu'énonce déjà
  // `compute_scope_paths.py`, appliquée ici au chemin de l'écran.

  @OnDatabaseBatchEvent('person', DatabaseEventAction.CREATED)
  async handlePersonCreate(
    payload: WorkspaceEventBatch<ObjectRecordCreateEvent>,
  ): Promise<void> {
    await this.handle(payload, 'companyId');
  }

  @OnDatabaseBatchEvent('opportunity', DatabaseEventAction.CREATED)
  async handleOpportunityCreate(
    payload: WorkspaceEventBatch<ObjectRecordCreateEvent>,
  ): Promise<void> {
    await this.handle(payload, 'companyId');
  }

  @OnDatabaseBatchEvent('visit', DatabaseEventAction.CREATED)
  async handleVisitCreate(
    payload: WorkspaceEventBatch<ObjectRecordCreateEvent>,
  ): Promise<void> {
    await this.handle(payload, 'clientId');
  }

  @OnDatabaseBatchEvent('clientProduct', DatabaseEventAction.CREATED)
  async handleClientProductCreate(
    payload: WorkspaceEventBatch<ObjectRecordCreateEvent>,
  ): Promise<void> {
    await this.handle(payload, 'clientId');
  }

  private async handle(
    payload: WorkspaceEventBatch<ObjectRecordCreateEvent>,
    parentIdField: string | undefined,
  ): Promise<void> {
    const { workspaceId } = payload;

    try {
      await this.assignScopePaths(payload, parentIdField);
    } catch (error) {
      // ⚠️ NE JAMAIS laisser une exception sortir d'ici — [[L97]]. Un listener de création
      // qui lève fait échouer la création elle-même : le commercial verrait une erreur au
      // lieu d'un enregistrement, ce qui est pire que le défaut qu'on répare. Un workspace
      // sans les champs custom Snetor (workspace neuf, workspace de test) tombe ici.
      this.logger.warn(
        `scopePath non pose sur le workspace ${workspaceId} (${payload.name}) — ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async assignScopePaths(
    payload: WorkspaceEventBatch<ObjectRecordCreateEvent>,
    parentIdField: string | undefined,
  ): Promise<void> {
    const { workspaceId, objectMetadata } = payload;
    const objectName = objectMetadata.nameSingular;

    await this.globalWorkspaceOrmManager.executeInWorkspaceContext(async () => {
      // `ObjectLiteral` et non les entités typées : `scopePath` et `allowedScopes` sont des
      // champs custom Snetor, absents des types d'entité upstream.
      const recordRepository =
        await this.globalWorkspaceOrmManager.getRepository<ObjectLiteral>(
          workspaceId,
          objectName,
          { shouldBypassPermissionChecks: true },
        );
      const memberRepository =
        await this.globalWorkspaceOrmManager.getRepository<ObjectLiteral>(
          workspaceId,
          'workspaceMember',
          { shouldBypassPermissionChecks: true },
        );
      const companyRepository = isDefined(parentIdField)
        ? await this.globalWorkspaceOrmManager.getRepository<ObjectLiteral>(
            workspaceId,
            'company',
            { shouldBypassPermissionChecks: true },
          )
        : undefined;

      // Un lot partage son créateur en pratique, mais rien ne le garantit : le cache est
      // indexé par membre plutôt que calculé une fois.
      const cacheMembre = new Map<string, string>();

      for (const event of payload.events) {
        try {
          await this.assignScopePath({
            event,
            parentIdField,
            recordRepository,
            memberRepository,
            companyRepository,
            cacheMembre,
          });
        } catch (error) {
          // Un enregistrement en échec ne prive pas les autres du lot de leur portée.
          this.logger.error(
            `scopePath non pose sur ${objectName} ${event.recordId}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
    }, buildSystemAuthContext(workspaceId));
  }

  private async assignScopePath({
    event,
    parentIdField,
    recordRepository,
    memberRepository,
    companyRepository,
    cacheMembre,
  }: {
    event: ObjectRecordCreateEvent;
    parentIdField: string | undefined;
    recordRepository: WorkspaceRepository<ObjectLiteral>;
    memberRepository: WorkspaceRepository<ObjectLiteral>;
    companyRepository: WorkspaceRepository<ObjectLiteral> | undefined;
    cacheMembre: Map<string, string>;
  }): Promise<void> {
    const { workspaceMemberId, recordId } = event;
    const cree = (event.properties.after ?? {}) as Record<string, unknown>;

    // 🔴 Pas de membre = contexte système ou clé API : c'est l'ingestion qui écrit, et elle
    // a sa propre chaîne de calcul de portée. Ne rien faire — poser le périmètre d'un
    // membre inexistant serait inventer une portée.
    if (!isDefined(workspaceMemberId)) {
      return;
    }

    // Ne JAMAIS écraser une portée déjà posée : le recalcul par lot en est le propriétaire,
    // et un import peut fournir la valeur juste.
    const dejaPose = cree[SCOPE_PATH_FIELD];

    if (typeof dejaPose === 'string' && dejaPose.trim() !== '') {
      return;
    }

    const scopePath = isDefined(parentIdField)
      ? await this.heriteDuParent({
          cree,
          parentIdField,
          companyRepository,
          memberRepository,
          workspaceMemberId,
          cacheMembre,
        })
      : await this.perimetreDuMembre({
          memberRepository,
          workspaceMemberId,
          cacheMembre,
        });

    if (scopePath === '') {
      // Créateur non cloisonné (sentinelle `*`) ou sans périmètre : ce n'est pas à lui de
      // décider de la portée de l'enregistrement. Le recalcul par lot tranchera.
      return;
    }

    await recordRepository.update(recordId, { [SCOPE_PATH_FIELD]: scopePath });
  }

  /** Portée du parent si elle existe, sinon celle du créateur. */
  private async heriteDuParent({
    cree,
    parentIdField,
    companyRepository,
    memberRepository,
    workspaceMemberId,
    cacheMembre,
  }: {
    cree: Record<string, unknown>;
    parentIdField: string;
    companyRepository: WorkspaceRepository<ObjectLiteral> | undefined;
    memberRepository: WorkspaceRepository<ObjectLiteral>;
    workspaceMemberId: string;
    cacheMembre: Map<string, string>;
  }): Promise<string> {
    const parentId = cree[parentIdField];

    if (
      typeof parentId === 'string' &&
      parentId !== '' &&
      isDefined(companyRepository)
    ) {
      const parent = await companyRepository.findOne({
        where: { id: parentId },
      });
      const portee = isDefined(parent)
        ? (parent as Record<string, unknown>)[SCOPE_PATH_FIELD]
        : undefined;

      if (typeof portee === 'string' && portee.trim() !== '') {
        return portee;
      }
    }

    // Parent absent (contact orphelin) ou parent encore sans portée — le cas d'une société
    // créée dans le même geste, que ce listener vient tout juste de servir. Retomber sur le
    // créateur aligne l'enfant sur ce que son parent va porter.
    return this.perimetreDuMembre({
      memberRepository,
      workspaceMemberId,
      cacheMembre,
    });
  }

  private async perimetreDuMembre({
    memberRepository,
    workspaceMemberId,
    cacheMembre,
  }: {
    memberRepository: WorkspaceRepository<ObjectLiteral>;
    workspaceMemberId: string;
    cacheMembre: Map<string, string>;
  }): Promise<string> {
    const enCache = cacheMembre.get(workspaceMemberId);

    if (isDefined(enCache)) {
      return enCache;
    }

    const membre = await memberRepository.findOne({
      where: { id: workspaceMemberId },
      // `select` explicite : les deux champs sont custom, une sélection par défaut peut
      // ne pas les hydrater.
      select: {
        id: true,
        [MEMBER_SCOPES_FIELD]: true,
        [MEMBER_SCOPE_FIELD]: true,
      },
    });

    const scope = isDefined(membre)
      ? resolveScope(
          readMemberScopesField(membre),
          readMemberCountryScopeField(membre),
        )
      : { kind: 'tokens' as const, allowed: [] };

    const scopePath =
      scope.kind === 'unscoped' ? '' : buildRecordScopePath(scope.allowed);

    cacheMembre.set(workspaceMemberId, scopePath);

    return scopePath;
  }
}
