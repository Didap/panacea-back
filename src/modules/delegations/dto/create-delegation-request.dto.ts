import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateDelegationRequestDto {
  @IsEmail()
  @MaxLength(320)
  targetEmail!: string;

  @IsString()
  @Matches(/^[A-Z0-9]{16}$/, { message: 'fiscalCode must be 16 uppercase alphanumeric chars' })
  targetFiscalCode!: string;

  @IsOptional()
  @IsBoolean()
  requestCanSubDelegate?: boolean;

  @IsOptional()
  @IsDateString()
  requestedExpiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
