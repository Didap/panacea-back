import {
  IsDateString,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateSubDelegationDto {
  @IsEmail()
  @MaxLength(320)
  targetEmail!: string;

  @IsString()
  @Matches(/^[A-Z0-9]{16}$/, { message: 'fiscalCode must be 16 uppercase alphanumeric chars' })
  targetFiscalCode!: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
