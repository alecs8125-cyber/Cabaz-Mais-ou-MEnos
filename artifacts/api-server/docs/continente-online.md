# Continente Online: sincronização controlada

## Segurança e pré-requisitos

- A service role é usada exclusivamente pelo CLI do api-server. Guardar
  `SUPABASE_SERVICE_ROLE_KEY` nas Secrets, nunca em variáveis públicas, ficheiros
  ou na app Expo. A app mantém apenas a chave publicável.
- O dry run é o modo por defeito; o transporte recusa qualquer mutação nesse modo.
- O commit exige `--commit`, `--limit` explícito entre 1 e 20, `--offset` explícito
  e uma credencial server-side válida.
- Aplicar previamente, após revisão, `sql/continente-online.sql` ao Supabase
  existente. O comando **não aplica SQL**, não cria tabelas/RPCs e não configura
  agendamentos. O preflight rejeita schema/RPC incompatível ou índices de
  identidade não confirmados antes de qualquer escrita.
- A migração torna `products.unit` anulável para não inventar unidades. Os
  índices únicos apenas protegem identidades Continente. Dados duplicados fazem
  a migração falhar; não são eliminados automaticamente.
- Se `stores.store_type` tiver uma constraint que não aceite `online`, é
  necessária uma migração explícita dessa constraint antes do primeiro commit.
  Nunca usar uma localização/loja física como alternativa.

## Comandos

```sh
pnpm --filter @workspace/api-server run sync:continente -- --limit=20 --offset=0
pnpm --filter @workspace/api-server run sync:continente -- --limit=20 --offset=0 --commit
```

O primeiro só lê e apresenta planos/impedimentos. O segundo, se todos os
pré-requisitos estiverem disponíveis, cria/reutiliza uma única loja lógica
`continente + online`, resolve no máximo 20 produtos e grava preços através da
RPC. Não existe modo de commit implícito nem endpoint de escrita na app.

## Resolução e consistência

Mapping verificado → produto `continente + SKU` → barcode exato → nome/marca
exatos e únicos → novo produto source-native. Mappings conflitantes, múltiplos
produtos do mesmo SKU e identidades inválidas produzem erros explícitos.
Ambiguidades no catálogo não selecionam candidatos: originam uma identidade
source-native distinta. Não se associam produtos a ProductGroups.

Antes de inserir um produto source-native, o SKU é novamente consultado. O
índice único impede duplicações concorrentes e a resolução relê após um conflito.
Atualizações preservam atributos anteriores quando os novos dados estão ausentes.

Produto e mapping são etapas idempotentes independentes. Se uma etapa posterior
falhar, um produto/mapping pode já ter sido criado; o relatório conta essas
escritas e a próxima execução reutiliza-os. Preço e histórico são atómicos na RPC.

## Política temporal e histórico

`captured_at` é a observação real; `valid_from` é esse instante;
`valid_until` é 36 horas depois, por política local do Cabaz, não por informação
do Continente. O comparador rejeita preços expirados.

A RPC usa um lock transacional por preço externo, recusa mudar o produto/loja
de uma identidade existente e ignora observações mais antigas. Só cria histórico
na primeira observação ou quando o valor muda; uma repetição do mesmo preço
atualiza a frescura sem duplicar histórico.

## App e verificação

Continente Online é consultado separadamente e participa independentemente da
zona manual. A consulta física continua localizada. O resultado transporta
apenas o ID/nome e o indicador online, sem distância ou localidade; cartão e
detalhe exibem “Online”. Pesquisa por nome/marca e cabaz aceitam barcode/unidade
nulos sem criar preços fictícios.

Testes isolados cobrem o contrato e a integração do fluxo com um repositório
em memória. Não substituem a confirmação real no Supabase após aplicar a
migração e configurar a Secret. A validação da RPC SQL em produção permanece
pendente até esse teste controlado.