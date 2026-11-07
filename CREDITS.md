# Источники 3D-моделей

## models/hand.glb — правая кисть: кожа, мышцы, связки, кости

- **Исходные данные:** BodyParts3D 4.0, набор `isa_BP3D_4.0_obj_99.zip` (полигонально упрощённые OBJ)
- **Скачано с:** https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/
- **Автор:** © The Database Center for Life Science (DBCLS), Япония
- **Лицензия:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
- **Страница лицензии:** https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html (обновлена 27.02.2025)
- **Требуемая подпись:** "BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International"

Внутри самих OBJ-файлов осталась старая строка про CC BY-SA 2.1 Japan, но действующая лицензия базы, указанная на официальной странице, — CC BY 4.0.

### Что изменено в этом проекте
Модель собрана скриптом `tools/build_hand.py`:
- взяты кости, мышцы, кожа и удерживатель сгибателей (flexor retinaculum) в области правой кисти и запястья;
- лучевая и локтевая кости, мышцы предплечья и кожа обрезаны примерно в 3 см выше запястья;
- у нескольких мышц в BodyParts3D перепутаны right и left в названии, это исправлено по положению в пространстве;
- переведено из миллиметров в метры, повёрнуто пальцами вверх, ладонью к зрителю;
- **добавлены схематичные коллатеральные связки суставов пальцев (28 шт.)**. Их нет в BodyParts3D, они построены по форме костей и показывают только примерное положение связок;
- добавлен скелет для анимации (17 суставов) и веса привязки кожи, мышц и связок к костям, чтобы пальцы и запястье могли двигаться. Положения и оси суставов рассчитаны приблизительно.

## Распознавание руки с вебкамеры

- **Библиотека:** MediaPipe Tasks Vision (`@mediapipe/tasks-vision` 0.10.21), © Google
- **Лицензия:** [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- **Откуда загружается:** https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/
- **Нейросеть:** Hand Landmarker (`hand_landmarker.task`, float16, версия 1), © Google, официальная модель MediaPipe (проект MediaPipe распространяется под Apache License 2.0)
- **Откуда загружается:** https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
- **Описание:** https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
- **Карточка модели (model card), там же условия использования:** https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf

Библиотека и нейросеть не лежат в проекте. Браузер загружает их (≈ 17 МБ) только когда пользователь включает камеру. Видео обрабатывается на устройстве пользователя и никуда не отправляется.

---

Проект учебный, не медицинский. Он не заменяет профессиональные анатомические источники.
