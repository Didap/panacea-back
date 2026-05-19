import { IsEnum, IsOptional } from 'class-validator';

export const delegationListRoles = ['delegator', 'delegate', 'all'] as const;
export type DelegationListRole = (typeof delegationListRoles)[number];

export class ListDelegationsQuery {
  @IsOptional()
  @IsEnum(delegationListRoles)
  as?: DelegationListRole;
}
