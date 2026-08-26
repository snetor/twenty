import { Injectable, Logger } from '@nestjs/common';

import { ILike, type ObjectLiteral } from 'typeorm';
import { type ObjectRecordCreateEvent } from 'twenty-shared/database-events';
import { isDefined } from 'twenty-shared/utils';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace.repository';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import {
  MEMBER_SCOPES_FIELD,
  SALESPERSON_SCOPE_TOKENS_FIELD,
} from 'src/engine/twenty-orm/utils/resolve-country-scope.util';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { type WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

// Poser le périmètre à la NAISSANCE du compte.
//
// `workspaceMember.allowedScopes` ne peut pas être rempli avant que le compte existe, et
// le compte n'existe qu'au premier login. Sans ce listener, chaque nouvel arrivant ouvre
// un CRM vide jusqu'au prochain passage manuel de `sync_member_scopes.py` — et un CRM
// vide, l'utilisateur en conclut que l'outil est cassé.
//
// La source est `salesperson.scopeTokens`, écrite depuis SAP pour TOUS les commerciaux,
// connectés ou non. Le listener ne fait que la recopier sur le compte qui vient de naître.
//
// Pourquoi un listener et pas un patch de `UserWorkspaceService.createWorkspaceMember` :
// un listener survit aux fusions de l'upstream, un patch de méthode non.
@Injectable()
export class ScopeAssignmentListener {
  private readonly logger = new Logger(ScopeAssignmentListener.name);

  constructor(
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
  ) {}

  @OnDatabaseBatchEvent('workspaceMember', DatabaseEventAction.CREATED)
  async handleCreate(
    payload: WorkspaceEventBatch<
      ObjectRecordCreateEvent<WorkspaceMemberWorkspaceEntity>
    >,
  ): Promise<void> {
    const { workspaceId } = payload;

    try {
      await this.assignScopes(payload, workspaceId);
    } catch (error) {
      // ⚠️ NE JAMAIS laisser une exception sortir d'ici. Le membre naît au PREMIER LOGIN :
      // une exception qui remonte casse la connexion elle-même, et pas seulement la pose du
      // périmètre. Mesuré — un workspace sans l'objet custom `salesperson` (workspace neuf,
      // workspace de test) fait lever `getRepository`, ce qui a fait tomber les 5 tests de
      // `secure-deployment` sur la PR #19 : ils échouaient dans leur mise en place, avant
      // d'exercer quoi que ce soit, et rien dans les logs ne pointait vers ce listener.
      this.logger.warn(
        `périmètre non posé sur le workspace ${workspaceId} — ` +
          `le referentiel salesperson est-il provisionné ? ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async assignScopes(
    payload: WorkspaceEventBatch<
      ObjectRecordCreateEvent<WorkspaceMemberWorkspaceEntity>
    >,
    workspaceId: string,
  ): Promise<void> {
    await this.globalWorkspaceOrmManager.executeInWorkspaceContext(async () => {
      // `ObjectLiteral` et non les entités typées : `allowedScopes` et `scopeTokens` sont
      // des champs custom Snetor, absents des types d'entité upstream.
      const workspaceMemberRepository =
        await this.globalWorkspaceOrmManager.getRepository<ObjectLiteral>(
          workspaceId,
          'workspaceMember',
          { shouldBypassPermissionChecks: true },
        );
      const salespersonRepository =
        await this.globalWorkspaceOrmManager.getRepository<ObjectLiteral>(
          workspaceId,
          'salesperson',
          { shouldBypassPermissionChecks: true },
        );

      // ponytail: une requête par membre créé — un lot vaut une ligne en pratique
      // (un compte naît à un login), grouper n'achèterait rien.
      for (const event of payload.events) {
        const member = event.properties.after as { id: string } & object;

        try {
          await this.assignScope({
            member,
            workspaceMemberRepository,
            salespersonRepository,
          });
        } catch (error) {
          // Un membre en échec ne prive pas les autres du lot de leur périmètre.
          this.logger.error(
            `périmètre non posé sur le workspaceMember ${member.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
    }, buildSystemAuthContext(workspaceId));
  }

  private async assignScope({
    member,
    workspaceMemberRepository,
    salespersonRepository,
  }: {
    member: { id: string } & object;
    workspaceMemberRepository: WorkspaceRepository<ObjectLiteral>;
    salespersonRepository: WorkspaceRepository<ObjectLiteral>;
  }): Promise<void> {
    const userEmail = (member as { userEmail?: string | null }).userEmail;

    if (!isDefined(userEmail) || userEmail.trim() === '') {
      return;
    }

    const salesperson = await salespersonRepository.findOne({
      where: { email: ILike(userEmail.trim()) },
    });

    if (!isDefined(salesperson)) {
      // Le lot B3 dit qu'un tel compte ne devrait pas exister : en voir un ici signale
      // que la porte d'entrée a été contournée.
      this.logger.warn(
        `aucun salesperson pour ${userEmail} — allowedScopes laissé vide, ce compte ouvrira un CRM vide`,
      );

      return;
    }

    const scopeTokens = (
      salesperson[SALESPERSON_SCOPE_TOKENS_FIELD] ?? ''
    ).trim();

    if (scopeTokens === '') {
      // Ne jamais écrire une chaîne vide : elle vaut refus, et serait indiscernable
      // d'un périmètre volontairement nul.
      this.logger.warn(
        `scopeTokens vide sur le salesperson de ${userEmail} — allowedScopes non écrit`,
      );

      return;
    }

    await workspaceMemberRepository.update(member.id, {
      [MEMBER_SCOPES_FIELD]: scopeTokens,
    });
  }
}
