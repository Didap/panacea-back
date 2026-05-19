import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { HealthDocumentsService } from './health-documents.service';
import { UploadHealthDocumentDto } from './dto/upload.dto';
import { ListHealthDocumentsQuery } from './dto/list.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { CodedException, ErrorCodes } from '../../common/constants/error-codes';

@Controller('documents')
export class HealthDocumentsController {
  constructor(private readonly documents: HealthDocumentsService) {}

  @Roles('patient')
  @Post()
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadHealthDocumentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    if (!file) throw new CodedException(ErrorCodes.DOCUMENT_FILE_MISSING);
    return this.documents.upload({
      actor,
      buffer: file.buffer,
      originalName: file.originalname,
      declaredMime: file.mimetype,
      title: dto.title,
      category: dto.category,
      notes: dto.notes,
      takenAt: dto.takenAt,
      ip: ipOf(req),
      userAgent: req.headers['user-agent'],
    });
  }

  @Roles('patient')
  @Get()
  async list(
    @Query() query: ListHealthDocumentsQuery,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.documents.list({
      actor,
      category: query.category,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
  }

  @Roles('patient')
  @Get(':id')
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.documents.view(id, actor, ipOf(req), req.headers['user-agent']);
  }

  @Roles('patient')
  @Get(':id/download')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const { doc, buffer } = await this.documents.download(
      id,
      actor,
      ipOf(req),
      req.headers['user-agent'],
    );
    res.setHeader('content-type', doc.mimeType);
    res.setHeader('content-length', String(doc.sizeBytes));
    res.setHeader(
      'content-disposition',
      `attachment; filename="${encodeURIComponent(doc.fileName)}"`,
    );
    res.end(buffer);
  }

  @Roles('patient')
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.documents.softDelete(id, actor, ipOf(req), req.headers['user-agent']);
  }
}

function ipOf(req: Request): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]?.trim();
  return req.ip ?? undefined;
}
