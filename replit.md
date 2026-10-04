# Cabaz Mais ou Menos

Aplicação mobile nativa em React Native, Expo e TypeScript, em português de Portugal. Inclui escolha manual da zona de compras, guardada localmente, e um cabaz com pesquisa de produtos no Supabase. A estrutura local de demonstração permanece preservada.

## Âmbito aprovado

- Quatro ecrãs: Início, Escolher zona, Meu cabaz e Comparação.
- Navegação inferior: Início, Cabaz e Comparar.
- No Início: marca “CABAZ MAIS OU MENOS”, slogan “Descobre onde o teu cabaz fica mais barato.” e botão “Criar cabaz”.
- O Início inclui as secções “O teu último cabaz” e “Promoções perto de ti”, apresentadas em cartões. O primeiro permite voltar ao cabaz desta sessão, sem histórico guardado. Não há promoções reais nem localização automática.
- No ecrã “Onde costumas fazer compras?”, seleções dependentes de distrito, concelho e freguesia. Alterar o distrito limpa concelho e freguesia; alterar o concelho limpa a freguesia.
- A zona só é atualizada ao tocar em “Guardar zona” e fica guardada no dispositivo com AsyncStorage. A Home mostra a freguesia e “Alterar zona”. Sair sem guardar não modifica a escolha anterior.
- As listas administrativas estão incluídas na aplicação e não exigem serviços externos. Fonte e cobertura documentadas em `artifacts/cabaz-mais-ou-menos/data/SOURCE.md`.
- A lista existente carrega `public.products` do Supabase ao abrir, apenas com `active = true`. A pesquisa por nome é aplicada no servidor, sem acrescentar filtros visuais. Carregamento, lista vazia e erro são explícitos; no erro mostrar “Não foi possível carregar os produtos. Tenta novamente.” e o botão “Tentar novamente”.
- Só quando a leitura do Supabase falhar, mostrar temporariamente os 24 produtos locais de demonstração, claramente identificados como fictícios, juntamente com o erro e o botão de repetição. Um resultado remoto vazio não ativa o fallback. Conservar a estrutura dos cartões. Ler apenas os campos usados e páginas limitadas; cancelar pedidos obsoletos e aguardar 300 ms após escrever.
- Em “Meu cabaz”: pesquisa de produtos por nome, adicionar/remover produtos e aumentar/diminuir quantidades. Adicionar novamente o mesmo produto aumenta a quantidade; o mínimo é 1, com remoção separada.
- `public.products` não contém preços. Guardar os produtos remotos no cabaz com os seus identificadores e atributos, sem os procurar no catálogo local. Subtotais e total sem preço são indisponíveis (`null`), nunca preços fictícios nem 0 €. Os valores de demonstração legados continuam calculados em cêntimos inteiros e identificados como tal.
- O cabaz fica apenas na memória da sessão e mantém-se ao navegar entre ecrãs. Persistência do cabaz e histórico não foram pedidos nesta fase; a persistência da zona permanece independente e inalterada.
- “Comparar preços” lê as lojas ativas de `public.stores` e os preços `verified` de `public.prices` através do cliente Supabase existente. Usa apenas preços já em vigor e o registo mais recente por par produto/loja; não usa registos rejeitados ou expirados. Os dados atualmente guardados com `source_type = demo` são fictícios, mesmo vindo do Supabase.
- Produtos locais de demonstração sem identificador remoto não são associados por nome a produtos no Supabase: contam como produtos em falta. Um preço ausente nunca é substituído por um preço local.
- Na comparação, o total inclui as quantidades; encontrados/em falta contam produtos distintos. Ordenar pelo total crescente, identificar totais parciais e colocar no fim as lojas sem qualquer produto encontrado (sem total disponível, nunca 0 €).
- A poupança só compara cabazes completos: menor total completo face à alternativa completa com o preço imediatamente superior, identificando a loja de referência. Produtos em falta não representam poupança; esta regra evita apresentar cabazes diferentes como equivalentes. Empates no menor total têm a mesma referência; sem diferença entre totais completos, não mostrar poupança.
- Os resultados derivam do cabaz atual da sessão e atualizam-se ao alterar os produtos ou quantidades. Não se guardam comparações ou histórico.
- Não acrescentar funcionalidades sem um novo pedido do utilizador.

## Restrições desta fase

Não criar login, GPS, localização automática, pagamentos, publicidade, APIs, backend ou preços de mercado inventados. A única ligação externa autorizada é o cliente Supabase manual, com serviços de leitura de `public.products`, `public.stores` e `public.prices`. O serviço de produtos mantém a pesquisa e a criação do cabaz; a comparação lê lojas e preços sem alterar o design, a navegação ou a estrutura local de demonstração. Não adicionar dependências desnecessárias.

O servidor API, os módulos de base de dados e o canvas são elementos pré-existentes do modelo de projeto; esta aplicação não os utiliza e não precisa de os iniciar. Não configurar bases de dados, tabelas ou permissões. Não usar a integração OAuth do Replit para Supabase nem pedir novas credenciais: usar apenas `EXPO_PUBLIC_SUPABASE_URL` e `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` já definidas no ambiente. Nunca usar `service_role`, `sb_secret` ou chaves diretamente no código.

## Continente Online — âmbito adicional aprovado

- O api-server pode sincronizar o canal Continente Online, usando uma service
  role exclusivamente server-side e guardada em Replit Secrets. A app nunca
  recebe essa credencial; nunca a definir em `.replit`/`userenv.shared` ou Git.
- Dry run por defeito; commit controlado exige limite explícito até 20 e offset.
  A migração preparada não é aplicada automaticamente.
- Resolver identidades por mapping/SKU/barcode/match conservador; quando não há
  correspondência segura, criar um produto source-native, sem inventar
  categoria, barcode, quantidade ou unidade.
- A loja lógica é exatamente `source_type=continente`, `external_id=online`,
  “Continente Online”, sem morada/coordenadas/localidade física.
- Preços só através de `upsert_verified_price_with_history`; validade local
  de 36 horas. Não adicionar produtos a ProductGroups neste passo.
- O comparador inclui este canal independentemente da zona manual e apresenta
  “Online”, sem distância. A lógica das lojas físicas mantém-se localizada.
- As antigas restrições a service role/escritas acima continuam válidas para
  a app e para outras fontes, não para este CLI server-side explicitamente autorizado.

## Estrutura

- `artifacts/cabaz-mais-ou-menos/` — aplicação Expo.
- `app/` dentro da aplicação — ecrãs e navegação Expo Router.
- `constants/colors.ts` — cores da aplicação.
- `assets/images/icon.png` — ícone local.

## Executar e verificar

- Iniciar através do workflow gerido `artifacts/cabaz-mais-ou-menos: expo`; não iniciar um segundo servidor Expo.
- `pnpm --filter @workspace/cabaz-mais-ou-menos run typecheck` — verificar TypeScript da aplicação.
- `pnpm --filter @workspace/cabaz-mais-ou-menos run test:products` — testar catálogo, pesquisa, quantidades, remoção e totais sem serviços externos.
- `pnpm --filter @workspace/cabaz-mais-ou-menos run test:comparison` — testar a lógica local legada e os totais, quantidades, ordenação, produtos em falta e poupanças dos preços do Supabase.
- `pnpm --filter @workspace/cabaz-mais-ou-menos run test:supabase-products` — testar o contrato de consultas, pesquisa, categorias, paginação e erros, sem rede ou credenciais.
- A pré-visualização Expo utiliza `REPLIT_EXPO_DEV_DOMAIN`, não o proxy partilhado.
- A pesquisa usa as duas variáveis públicas do ambiente para ler o Supabase. O restante funcionamento local mantém-se; não introduzir autenticação nem armazenamento de sessões.

## Convenções

- pnpm para dependências; conservar as versões Expo/React Native compatíveis fornecidas pelo projeto.
- Configuração Expo estática em `app.json`.
- Fontes e imagens locais; as únicas leituras externas autorizadas são os serviços Supabase de produtos, lojas e preços, sendo o de produtos a fonte principal da pesquisa.
- Respeitar áreas seguras de iOS/Android, acessibilidade e ecrãs pequenos.
- Melhorias de design devem preservar a arquitetura, a navegação e o comportamento existentes; não acrescentar funcionalidades como parte de uma revisão visual.
