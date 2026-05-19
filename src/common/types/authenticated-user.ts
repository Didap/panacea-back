import type { UserRole } from '../../database/schema/users';

export type AuthenticatedUser = {
  id: string;
  email: string;
  role: UserRole;
};
