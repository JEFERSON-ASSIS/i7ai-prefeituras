const test=require('node:test'); const assert=require('node:assert/strict');
const {createCanvas}=require('@napi-rs/canvas');
const {validateKnowledgeUpload}=require('../dist/knowledge/knowledge-image');
const {extractDocumentText}=require('../dist/knowledge/document-extractor');
function draw(width=1200,height=500,lines=['GESTAO DOCUMENTAL MUNICIPAL','O prazo de publicacao e de 30 dias.']){
 const canvas=createCanvas(width,height);const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,width,height);ctx.fillStyle='black';ctx.font='48px Arial';
 lines.forEach((line,i)=>ctx.fillText(line,60,130+i*110));return canvas;
}
const upload=(name,mimetype,buffer)=>({originalname:name,mimetype,size:buffer.length,buffer});
test('accepts PNG, JPEG and WebP by signature',()=>{
 const canvas=draw();
 assert.equal(validateKnowledgeUpload(upload('a.png','image/png',canvas.toBuffer('image/png'))),'image/png');
 assert.equal(validateKnowledgeUpload(upload('a.JPG','image/jpeg',canvas.toBuffer('image/jpeg'))),'image/jpeg');
 assert.equal(validateKnowledgeUpload(upload('a.jpeg','application/octet-stream',canvas.toBuffer('image/jpeg'))),'image/jpeg');
 assert.equal(validateKnowledgeUpload(upload('a.webp','image/webp',canvas.toBuffer('image/webp'))),'image/webp');
});
test('rejects bad signature, MIME mismatch, size and megapixel limits',()=>{
 const png=draw().toBuffer('image/png');
 assert.throws(()=>validateKnowledgeUpload(upload('a.png','image/png',Buffer.from('not an image at all, just text padding padding'))),/PNG válida/);
 assert.throws(()=>validateKnowledgeUpload(upload('a.jpg','image/jpeg',png)),/JPEG válida/);
 assert.throws(()=>validateKnowledgeUpload(upload('a.png','application/pdf',png)),/tipo MIME/);
 assert.throws(()=>validateKnowledgeUpload({originalname:'a.png',mimetype:'image/png',size:21*1024*1024,buffer:Buffer.alloc(21*1024*1024)}),/20 MB/);
 const huge=Buffer.from(png);huge.writeUInt32BE(7000,16);huge.writeUInt32BE(7000,20);
 assert.throws(()=>validateKnowledgeUpload(upload('a.png','image/png',huge)),/40 megapixels/);
});
test('document formats still go through the document validator',()=>{
 assert.equal(validateKnowledgeUpload(upload('a.txt','text/plain',Buffer.from('oi'))),'text/plain');
 assert.throws(()=>validateKnowledgeUpload(upload('a.gif','image/gif',Buffer.from('GIF89a'))),/não suportado/);
});
test('local OCR reads Portuguese text from PNG, JPEG and WebP',{timeout:240000},async()=>{
 const canvas=draw();
 for(const type of ['image/png','image/jpeg','image/webp']){
  const text=await extractDocumentText('foto.'+(type==='image/jpeg'?'jpg':type.slice(6)),canvas.toBuffer(type));
  assert.match(text,/GEST[AÃ]O DOCUMENTAL/i,type);assert.match(text,/30 dias/i,type);
 }
});
test('image without recognizable text fails with a clear message',{timeout:120000},async()=>{
 const canvas=createCanvas(400,300);const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,400,300);
 await assert.rejects(extractDocumentText('vazia.png',canvas.toBuffer('image/png')),/Não foi possível ler texto nesta imagem\./);
});
