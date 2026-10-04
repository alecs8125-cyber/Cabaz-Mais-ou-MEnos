# Localizações administrativas de Portugal

`portugal-locations.json` é uma cópia estática, sem geometria, da hierarquia
administrativa da **Carta Administrativa Oficial de Portugal (CAOP 2025)** da
Direção-Geral do Território (DGT). A seleção de locais na aplicação não precisa
de acesso à rede.

## Fonte, versão e licença

- Fonte oficial e metadados de licenciamento:
  - Continente: https://dados.gov.pt/pt/datasets/carta-administrativa-oficial-de-portugal-caop2025-continente
  - Açores (RAA): https://dados.gov.pt/pt/datasets/carta-administrativa-oficial-de-portugal-caop2025-raa
  - Madeira (RAM): https://dados.gov.pt/pt/datasets/carta-administrativa-oficial-de-portugal-caop2025-ram
- Os três registos de dados.gov.pt indicam **Creative Commons Attribution 4.0 (CC BY 4.0)**. Atribuição: Direção-Geral do Território (DGT), *Carta Administrativa Oficial de Portugal, CAOP 2025*; os códigos DTMNFR das freguesias são atribuídos pelo Instituto Nacional de Estatística (INE). Termos: https://creativecommons.org/licenses/by/4.0/
- Versão de referência: **CAOP 2025**, com alterações legislativas publicadas até **31 de dezembro de 2025**. A DGT anunciou a publicação em **18 de fevereiro de 2026**: https://www.dgterritorio.gov.pt/carta-administrativa-oficial-de-portugal-caop-2025
- Extração dos serviços públicos WFS da DGT: **CAOP 2025**. Apenas as propriedades de identificação e contagem foram pedidas; nenhuma geometria foi descarregada ou guardada.

## URLs de extração

Serviço WFS `GetFeature`, versão `2.0.0`, `outputFormat=csv`, paginado com
`count=500` e `startIndex=0,500,...`. URLs de referência (sem parâmetros de
paginação; os nomes de camadas e as propriedades selecionadas são exatos):

| Região | Camada WFS | Propriedades |
| --- | --- | --- |
| Continente | [cont_distritos](https://geo2.dgterritorio.gov.pt/geoserver/caop_continente/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=caop_continente%3Acont_distritos&propertyName=dt%2Cdistrito%2Cn_municipios%2Cn_freguesias&outputFormat=csv) | `dt,distrito,n_municipios,n_freguesias` |
| Continente | [cont_municipios](https://geo2.dgterritorio.gov.pt/geoserver/caop_continente/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=caop_continente%3Acont_municipios&propertyName=dtmn%2Cmunicipio%2Cdistrito_ilha%2Cn_freguesias&outputFormat=csv) | `dtmn,municipio,distrito_ilha,n_freguesias` |
| Continente | [cont_freguesias](https://geo2.dgterritorio.gov.pt/geoserver/caop_continente/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=caop_continente%3Acont_freguesias&propertyName=dtmnfr%2Cfreguesia%2Cmunicipio%2Cdistrito_ilha&outputFormat=csv) | `dtmnfr,freguesia,municipio,distrito_ilha` |
| Açores, grupo central/oriental | [raa_cen_ori_municipios](https://geo2.dgterritorio.gov.pt/geoserver/caop_raa/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=caop_raa%3Araa_cen_ori_municipios&propertyName=dtmn%2Cmunicipio%2Cdistrito_ilha%2Cn_freguesias&outputFormat=csv) | `dtmn,municipio,distrito_ilha,n_freguesias` |
| Açores, grupo central/oriental | [raa_cen_ori_freguesias](https://geo2.dgterritorio.gov.pt/geoserver/caop_raa/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=caop_raa%3Araa_cen_ori_freguesias&propertyName=dtmnfr%2Cfreguesia%2Cmunicipio%2Cdistrito_ilha&outputFormat=csv) | `dtmnfr,freguesia,municipio,distrito_ilha` |
| Açores, grupo ocidental | [raa_oci_municipios](https://geo2.dgterritorio.gov.pt/geoserver/caop_raa/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=caop_raa%3Araa_oci_municipios&propertyName=dtmn%2Cmunicipio%2Cdistrito_ilha%2Cn_freguesias&outputFormat=csv) | `dtmn,municipio,distrito_ilha,n_freguesias` |
| Açores, grupo ocidental | [raa_oci_freguesias](https://geo2.dgterritorio.gov.pt/geoserver/caop_raa/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=caop_raa%3Araa_oci_freguesias&propertyName=dtmnfr%2Cfreguesia%2Cmunicipio%2Cdistrito_ilha&outputFormat=csv) | `dtmnfr,freguesia,municipio,distrito_ilha` |
| Madeira | [ram_municipios](https://geo2.dgterritorio.gov.pt/geoserver/caop_ram/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=caop_ram%3Aram_municipios&propertyName=dtmn%2Cmunicipio%2Cdistrito_ilha%2Cn_freguesias&outputFormat=csv) | `dtmn,municipio,distrito_ilha,n_freguesias` |
| Madeira | [ram_freguesias](https://geo2.dgterritorio.gov.pt/geoserver/caop_ram/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=caop_ram%3Aram_freguesias&propertyName=dtmnfr%2Cfreguesia%2Cmunicipio%2Cdistrito_ilha&outputFormat=csv) | `dtmnfr,freguesia,municipio,distrito_ilha` |

## Cobertura e tratamento

| Grupo no JSON | Grupos/distritos | Municípios | Freguesias |
| --- | ---: | ---: | ---: |
| Portugal continental | 18 | 278 | 3049 |
| Região Autónoma dos Açores | 1 | 19 | 156 |
| Região Autónoma da Madeira | 1 | 11 | 54 |
| **Total** | **20** | **308** | **3259** |

Os 18 distritos continentais usam o código oficial `dt` de dois caracteres.
As regiões autónomas não são distritos: são **dois grupos de seleção
explicitamente identificados**, com os identificadores locais `RAA` e `RAM`;
os municípios insulares aparecem diretamente sob a sua região. Os municípios
usam os códigos oficiais `dtmn` de quatro caracteres; as freguesias, os
códigos oficiais `dtmnfr` de seis caracteres. Os quatro primeiros caracteres
de cada código de freguesia identificam o seu município. Alguns códigos
oficiais de freguesia da CAOP 2025 são **alfanuméricos** (por exemplo,
`0302FA`); todos os identificadores são strings e não devem ser convertidos
para números. Os nomes são os da fonte, apresentados por ordem alfabética
pt-PT em cada nível.

Validação efetuada: identificadores únicos em cada nível (e códigos de
freguesia globalmente únicos), grupos/municípios/freguesias não vazios,
contagem de freguesias de cada município e contagens continentais por
distrito iguais às publicadas no WFS, total de 308 municípios e 3259
freguesias, incluindo **Faro → Loulé → Quarteira**.

Limites: trata-se de uma fotografia da CAOP 2025, não de uma atualização
automática; alterações administrativas posteriores exigirão regenerar este
ficheiro a partir de uma versão mais recente. A divisão por ilhas dos Açores
e da Madeira não foi acrescentada como quarto nível, pois o formato pedido
tem somente grupo → município → freguesia.