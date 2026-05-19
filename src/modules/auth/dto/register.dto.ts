import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { userRoles, type UserRole } from '../../../database/schema/users';

const ALLOWED_SIGNUP_ROLES: UserRole[] = ['patient', 'doctor'];

export class RegisterDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsEnum(userRoles)
  role!: UserRole;

  @IsString()
  @Length(1, 100)
  firstName!: string;

  @IsString()
  @Length(1, 100)
  lastName!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9]{16}$/, { message: 'fiscalCode must be 16 alphanumeric chars' })
  fiscalCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  specialization?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  licenseNumber?: string;
}

export function assertSignupRoleAllowed(role: UserRole): asserts role is 'patient' | 'doctor' {
  if (!ALLOWED_SIGNUP_ROLES.includes(role)) {
    throw new Error('ROLE_NOT_ALLOWED');
  }
}
