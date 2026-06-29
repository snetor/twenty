import { isDefined } from 'twenty-shared/utils';

import { type WorkspacePreQueryHookInstance } from 'src/engine/api/graphql/workspace-query-runner/workspace-query-hook/interfaces/workspace-query-hook.interface';
import { type UpdateOneResolverArgs } from 'src/engine/api/graphql/workspace-resolver-builder/interfaces/workspace-resolvers-builder.interface';

import { STANDARD_ERROR_MESSAGE } from 'src/engine/api/common/common-query-runners/errors/standard-error-message.constant';
import {
  GraphqlQueryRunnerException,
  GraphqlQueryRunnerExceptionCode,
} from 'src/engine/api/graphql/graphql-query-runner/errors/graphql-query-runner.exception';
import { WorkspaceQueryHook } from 'src/engine/api/graphql/workspace-query-runner/workspace-query-hook/decorators/workspace-query-hook.decorator';
import { CountryCodeFromRelationService } from 'src/engine/core-modules/country-code-derivation/services/country-code-from-relation.service';
import { type CountryCodeRecord } from 'src/engine/core-modules/country-code-derivation/utils/derive-country-code.util';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';

@WorkspaceQueryHook(`*.updateOne`)
export class CountryCodeUpdateOnePreQueryHook implements WorkspacePreQueryHookInstance {
  constructor(
    private readonly countryCodeFromRelationService: CountryCodeFromRelationService,
  ) {}

  async execute(
    authContext: WorkspaceAuthContext,
    objectName: string,
    payload: UpdateOneResolverArgs<CountryCodeRecord>,
  ): Promise<UpdateOneResolverArgs<CountryCodeRecord>> {
    if (!isDefined(payload.data)) {
      throw new GraphqlQueryRunnerException(
        'Payload data is required',
        GraphqlQueryRunnerExceptionCode.INVALID_QUERY_INPUT,
        { userFriendlyMessage: STANDARD_ERROR_MESSAGE },
      );
    }

    const [recordWithCountryCode] =
      await this.countryCodeFromRelationService.injectCountryCode({
        records: [payload.data],
        objectMetadataNameSingular: objectName,
        authContext,
      });

    return {
      ...payload,
      data: recordWithCountryCode,
    };
  }
}
