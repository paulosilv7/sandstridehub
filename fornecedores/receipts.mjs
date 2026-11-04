export const RECEIPT_BUCKET='fin-comprovantes';
export const MAX_RECEIPT_SIZE=5*1024*1024;
const formats={pdf:{mime:'application/pdf',test:b=>String.fromCharCode(...b.slice(0,5))==='%PDF-'},png:{mime:'image/png',test:b=>[137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v)},jpg:{mime:'image/jpeg',test:b=>b[0]===255&&b[1]===216&&b[2]===255}};
export async function validateReceipt(file){
 if(!file||!Number.isInteger(file.size)||file.size<=0)throw new Error('Escolha um arquivo válido.');
 if(file.size>MAX_RECEIPT_SIZE)throw new Error('O comprovante deve ter no máximo 5 MB.');
 const extension=file.name.split('.').pop().toLowerCase().replace('jpeg','jpg'),format=formats[extension];
 if(!format||file.type&&file.type!==format.mime)throw new Error('Use um comprovante PDF, JPG ou PNG.');
 const bytes=new Uint8Array(await file.slice(0,8).arrayBuffer());
 if(!format.test(bytes))throw new Error('O conteúdo do arquivo não corresponde ao formato informado.');
 return{file,name:file.name.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,200),mime:format.mime,size:file.size,extension};
}
export class ReceiptStore{
 constructor(client){this.client=client;this.paths=new WeakMap();this.busy=false;}
 async list(){const{data,error}=await this.client.rpc('fin_receipts_read');if(error)throw error;return data||[];}
 async upload(entryId,prepared){
  if(this.busy)throw new Error('Aguarde o envio atual.');this.busy=true;
  try{
   let paths=this.paths.get(prepared.file);if(!paths){paths=new Map();this.paths.set(prepared.file,paths);}let path=paths.get(entryId);if(!path){path=entryId+'/'+crypto.randomUUID()+'.'+prepared.extension;paths.set(entryId,path);}
   const bucket=this.client.storage.from(RECEIPT_BUCKET);let uploadError;
   try{const{error}=await bucket.upload(path,prepared.file,{contentType:prepared.mime,upsert:false,cacheControl:'0'});uploadError=error;}catch(error){uploadError=error;}
   // A resposta do upload pode se perder depois de o arquivo chegar. A vinculação
   // é idempotente e confirma a existência real do objeto antes de aceitar o anexo.
   const{data,error}=await this.client.rpc('fin_receipt_link',{entry_id:entryId,object_path:path,file_name:prepared.name,mime_type:prepared.mime,byte_size:prepared.size});
   if(error)throw uploadError||error;return data;
  }finally{this.busy=false;}
 }
 async download(receipt){if(receipt.deletedAt)throw new Error('Comprovante removido após o prazo de retenção.');const{data,error}=await this.client.storage.from(RECEIPT_BUCKET).download(receipt.path);if(error)throw error;return data;}
}
