import { Injectable } from '@nestjs/common';

import { In } from 'typeorm';
import { isDefined } from 'twenty-shared/utils';

import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import {
  type CountryScope,
  isCountryInScope,
  readMemberCountryScopeField,
  readRecordCountryCodeField,
  resolveCountryScope,
} from 'src/engine/twenty-orm/utils/resolve-country-scope.util';
import { type PersonWorkspaceEntity } from 'src/modules/person/standard-objects/person.workspace-entity';
import { type WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

// Cloisonnement par pays des chemins qui s'exécutent en contexte SYSTÈME.
//
// Le filtre du choke-point ORM (`apply-country-permission-filter.util.ts`) ne s'applique
// qu'à un contexte utilisateur : il sort immédiatement sur un contexte système. Les
// resolvers des onglets Emails et Calendar en dépendent — ils lisent la messagerie sous
// `buildSystemAuthContext` parce que la famille `message*` / `calendarEvent*` est en
// default-deny côté ORM, et ils résolvent leurs personnes avec
// `shouldBypassPermissionChecks: true`. Résultat : un `companyId`, `personId` ou
// `opportunityId` quelconque était accepté, y compris hors du périmètre du membre.
//
// Ce service pose le même périmètre à la main sur ces chemins, à partir de la même
// sémantique (`resolve-country-scope.util.ts`), au seul endroit où les trois entrées se
// rejoignent : la liste de personnes.
@Injectable()
export class CountryScopeService {
  constructor(
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
  ) {}

  /**
   * Périmètre du membre correspondant à un `userId`, pour les surfaces qui ne connaissent
   * que l'utilisateur — les outils de l'agent, dont le `ToolExecutionContext`.
   *
   * `userId` absent = exécution sans utilisateur (workflow, job) : rendu `unscoped`, comme
   * le fait le filtre ORM pour tout contexte non-utilisateur. Un membre introuvable est en
   * revanche un cas anormal, et il est rendu `{ countries: [] }` — default-deny.
   */
  async resolveScopeForUser({
    userId,
    workspaceId,
  }: {
    userId: string | undefined;
    workspaceId: string;
  }): Promise<CountryScope> {
    if (!isDefined(userId)) {
      return { kind: 'unscoped' };
    }

    const authContext = buildSystemAuthContext(workspaceId);

    return this.globalWorkspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const workspaceMemberRepository =
          await this.globalWorkspaceOrmManager.getRepository<WorkspaceMemberWorkspaceEntity>(
            workspaceId,
            'workspaceMember',
            { shouldBypassPermissionChecks: true },
          );

        const workspaceMember = await workspaceMemberRepository.findOne({
          where: { userId },
        });

        if (!isDefined(workspaceMember)) {
          return { kind: 'countries', allowed: [] };
        }

        return resolveCountryScope(
          readMemberCountryScopeField(workspaceMember),
        );
      },
      authContext,
    );
  }

  /**
   * Restreint une liste de personnes au périmètre pays du membre courant.
   *
   * Rend la liste inchangée si le workspace n'est pas cloisonné (champ `allowedCountries`
   * absent) ou si le membre est « tous pays ». Rend une liste vide si le membre est
   * introuvable ou si aucune des personnes n'est dans son périmètre — l'appelant doit
   * alors renvoyer un résultat vide, pas tout le workspace.
   *
   * Une personne sans `countryCode` est écartée, comme le fait le SQL du choke-point ORM.
   */
  async keepPersonIdsInScope({
    personIds,
    workspaceMemberId,
    workspaceId,
  }: {
    personIds: string[];
    workspaceMemberId: string;
    workspaceId: string;
  }): Promise<string[]> {
    if (personIds.length === 0) {
      return [];
    }

    const authContext = buildSystemAuthContext(workspaceId);

    return this.globalWorkspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const workspaceMemberRepository =
          await this.globalWorkspaceOrmManager.getRepository<WorkspaceMemberWorkspaceEntity>(
            workspaceId,
            'workspaceMember',
            { shouldBypassPermissionChecks: true },
          );

        const workspaceMember = await workspaceMemberRepository.findOne({
          where: { id: workspaceMemberId },
        });

        if (!isDefined(workspaceMember)) {
          return [];
        }

        const scope = resolveCountryScope(
          readMemberCountryScopeField(workspaceMember),
        );

        if (scope.kind === 'unscoped') {
          return personIds;
        }

        const personRepository =
          await this.globalWorkspaceOrmManager.getRepository<PersonWorkspaceEntity>(
            workspaceId,
            'person',
            { shouldBypassPermissionChecks: true },
          );

        const persons = await personRepository.find({
          where: { id: In(personIds) },
        });

        return persons
          .filter((person) =>
            isCountryInScope(scope, readRecordCountryCodeField(person)),
          )
          .map((person) => person.id);
      },
      authContext,
    );
  }
}
