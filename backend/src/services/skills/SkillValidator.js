export class SkillValidator {
  constructor(options) {
    this.skillCatalog = options.skillCatalog;
  }

  async validate(identifier, options = {}) {
    return this.skillCatalog.validateSkill(identifier, options);
  }
}
