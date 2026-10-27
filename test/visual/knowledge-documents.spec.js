import { test, expect } from '@playwright/test';
import { mockSession } from './fixtures';

test('documentos da base: lista, envia imagem e mantém a aba Documentos',async({page})=>{
  const writes=[];await mockSession(page,{writes});
  await page.goto('/?module=knowledge');
  await page.getByRole('button',{name:'Documentos da base Legislação municipal'}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('heading',{name:'Documentos da base Legislação municipal'})).toBeVisible();
  await expect(dialog.getByText('Guia municipal.pdf')).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Baixar Guia municipal.pdf'})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Reprocessar Guia municipal.pdf'})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Excluir Guia municipal.pdf'})).toBeVisible();
  await expect(dialog.getByText(/imagens \(PNG, JPG, WebP\).*imagens até 20 MB/)).toBeVisible();
  expect(await dialog.locator('input[type=file]').getAttribute('accept')).toContain('.webp');
  await dialog.locator('input[type=file]').setInputFiles({name:'ata.png',mimeType:'image/png',buffer:Buffer.from('89504e470d0a1a0a','hex')});
  await expect(page.getByText('1 documento(s) enviado(s) para processamento.')).toBeVisible();
  expect(writes[0].path).toBe('/documents/upload');expect(writes[0].body).toContain('base-1');expect(writes[0].body).toContain('ata.png');
  await dialog.getByRole('button',{name:'Fechar',exact:true}).last().click();
  await page.getByRole('button',{name:'Editar'}).click();
  await expect(page.getByRole('button',{name:'Adicionar documentos'})).toBeVisible();
  await page.getByRole('button',{name:'Adicionar documentos'}).click();
  await expect(page.getByRole('heading',{name:'Documentos da base Legislação municipal'})).toBeVisible();
  await page.goto('/?module=documents');
  await expect(page.getByRole('button',{name:'Carregar documento'})).toBeDisabled();
});
